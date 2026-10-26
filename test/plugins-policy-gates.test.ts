import {afterEach,expect,test} from "bun:test";
import {chmodSync,existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,tmpDir} from "./helpers";
import * as tasks from "../src/core/tasks";
import {delegate as lowerDelegate} from "../src/tasks/api";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {shutdownPlugins} from "../src/plugins";
import {policyGateFixture as fixture} from "./fixtures/policy-host";

test("real core and lower creation gateways veto before task persistence or launch",async()=>{
 for(const delegate of [tasks.delegate,lowerDelegate]){
  const f=fixture({verdict:"veto",reason:"blocked"});
  await expect(Promise.resolve().then(()=>delegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn))).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
  expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
 }
});

test("real delegate amendments map only eligible fields before commit",async()=>{
 const f=fixture({verdict:"amend",amend:{kind:"tests",requestedExecutor:"codex",placement:"new"}});
 const result=await tasks.delegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn);
 expect(result).toMatchObject({kind:"tests",requestedExecutor:"codex",placement:{requested:"new"}});
 expect(f.launches()).toBe(1);
});

test("concurrent same-key creation invokes policy once and replays the original",async()=>{
 const f=fixture({verdict:"allow"},30),input={brief:{goal:"work",repo:f.repo},requestId:"same"};
 const [a,b]=await Promise.all([tasks.delegate(f.ctx,input,f.spawn),tasks.delegate(f.ctx,input,f.spawn)]);
 expect(a.id).toBe(b.id);expect(f.calls()).toHaveLength(1);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(1);
 await expect(tasks.delegate(f.ctx,{...input,brief:{...input.brief,goal:"different"}},f.spawn)).rejects.toMatchObject({code:"conflict"});
 expect(f.calls()).toHaveLength(1);
});

test("configuration race during creation leaves no persisted task or launch",async()=>{
 const f=fixture({verdict:"allow"},40);
 const pending=Promise.resolve().then(()=>tasks.delegate(f.ctx,{brief:{goal:"work",repo:f.repo}},f.spawn));
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);
 writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,config:{"fx-policy":{changed:true}}}}));
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});


test("retry and answer veto preserve original task and create no retry",async()=>{
 for(const answering of [false,true]) {
  const f=fixture({verdict:"veto",reason:"blocked"});
  const task=createTask(f.ctx,{brief:{goal:"work",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});
  updateTask(f.ctx,task.id,t=>{t.state=answering?"needs_input":"failed";if(answering)t.question={text:"question",at:f.ctx.now};});
  const before=readTask(f.ctx,task.id);
  const deps={delegate:(c:typeof f.ctx,i:Parameters<typeof tasks.delegate>[1])=>tasks.delegate(c,i,f.spawn)};
  const pending=answering?tasks.answer(f.ctx,task.id,"answer",{},deps):tasks.retry(f.ctx,task.id,{},deps);
  await expect(pending).rejects.toMatchObject({code:"not_allowed"});
  expect(readTask(f.ctx,task.id)).toEqual(before);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);
 }
});

test("trusted operation cancellation during policy never commits a task",async()=>{
 const f=fixture({verdict:"allow"},80),abort=new AbortController();
 const pending=tasks.delegate(f.ctx,{brief:{goal:"work",repo:f.repo},admissionSignal:abort.signal},f.spawn);
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);
 abort.abort();await expect(pending).rejects.toMatchObject({code:"not_allowed"});expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});

test("retired admission lease during policy prevents post-await creation",async()=>{
 const {beginWorkSync,finishWorkSync}=await import("../src/update/desktop/admission");
 const f=fixture({verdict:"allow"},60);
 const lease=beginWorkSync(f.ctx,{kind:"launch",id:"gate-test",label:"Gate test"});
 const pending=tasks.delegate(f.ctx,{brief:{goal:"work",repo:f.repo},admissionLease:lease},f.spawn);
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);
 finishWorkSync(f.ctx,lease);
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(listTasksWhere(f.ctx)).toEqual([]);expect(f.launches()).toBe(0);
});
