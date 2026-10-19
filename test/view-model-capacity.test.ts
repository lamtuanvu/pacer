import { expect, test } from "bun:test";
import { capacityNote, queueWait } from "../src/view-model/capacity";
import type { ClientSnapshot, ClientTask } from "../src/view-model/snapshot";
import fixture from "./fixtures/ui/snapshot.json";
import type { ExecutorRow } from "../src/api/read-model/types";
import { queueCapacity } from "../src/tasks/capacity";
import { capacityFixture } from "./read-model-helpers";

const snapshot = fixture as unknown as ClientSnapshot;
test("shared capacity notes name the machine or host", () => {
 const row = {...snapshot.executors![0]!,limitedBy:'machine'} as ExecutorRow;
 expect(capacityNote(row,snapshot)).toBe('Limited to 2 by this machine');
 expect(capacityNote({...row,limitedBy:'host',host:'devbox'},snapshot)).toBe(`Limited to ${snapshot.hosts!.find(h=>h.alias==='devbox')!.maxTasks} by devbox`);
 expect(capacityNote({...row,limitedBy:undefined},snapshot)).toBeNull();
});
test("queue copy identifies each capacity limit and tolerates older snapshots", () => {
 for(const [limit,place] of [['executor','this executor'],['machine','this machine'],['host','this host']] as const) {
  const task={state:'queued',queue:{reason:'no_slot',since:1,position:1,limit,capacity:{used:2,max:2}}} as ClientTask;
  expect(queueWait(task,{...snapshot,machine:{used:2,max:2}})).toBe(`Waiting: ${place} is running 2 of 2`);
 }
 expect(queueWait({queue:{reason:'no_slot',since:1,position:1}} as ClientTask,{} as ClientSnapshot)).toBe('Waiting for parallel task capacity');
 expect(queueWait({queue:{reason:'paused',since:1,position:1}} as ClientTask,snapshot)).toBe('Waiting: delegation is paused');
});
test("host queue metadata and executor-first precedence match scheduling", () => {
 const {s}=capacityFixture();s.runners['codex@devbox']!.maxTasks=4;
 const use={byExecutor:{'codex@devbox':2},byHost:{devbox:3},local:0};
 expect(queueCapacity(s,'codex@devbox',use)).toEqual({limit:'host',capacity:{used:3,max:3}});
 use.byExecutor['codex@devbox']=4;
 expect(queueCapacity(s,'codex@devbox',use)).toEqual({limit:'executor',capacity:{used:4,max:4}});
 expect(queueCapacity(s,'codex',{byExecutor:{},byHost:{},local:0})).toBeUndefined();
});

test("queue copy uses the last scheduling check ahead of an older client snapshot", () => {
 const task={queue:{reason:'no_slot',since:1,position:1,limit:'machine',capacity:{used:3,max:3}}} as ClientTask;
 expect(queueWait(task,{...snapshot,machine:{used:0,max:2}})).toBe('Waiting: this machine is running 3 of 3');
});

test('executor usage follows the account/planner verdict independently of readiness', async () => {
  const { executorPace } = await import('../src/view-model/capacity');
  const { paceStatus } = await import('../src/view-model/words');
  const fixture = (await import('./fixtures/ui/snapshot.json')).default;
  const snapshot = structuredClone(fixture) as unknown as import('../src/view-model/snapshot').ClientSnapshot;
  snapshot.planner = {...snapshot.planner!,usedPct:37,pacePct:20,verdict:'ahead'};
  const executor = {...snapshot.executors![0]!,id:snapshot.planner.runner,state:'ready' as const,tone:'good' as const,usedPct:37};
  expect(executorPace(executor,snapshot)).toEqual(paceStatus('ahead'));
  snapshot.accounts = [{name:executor.account,agent:executor.agent,source:'default',usedPct:37,pacePct:20,window:'week',resetsAt:null,verdict:'AHEAD',signedIn:true,executors:['other']}];
  expect(executorPace({...executor,id:'other'},snapshot)).toEqual(paceStatus('ahead'));
  expect(executorPace({...executor,id:'unknown',account:'missing'},snapshot)).toEqual(paceStatus('unknown'));
});
