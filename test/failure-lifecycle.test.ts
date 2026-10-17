import { expect, test } from "bun:test";
import { emptySnapshot, parseSnapshot, type TaskData } from "../src/link/envelope";
import { taskData, pumpOnce } from "../src/link/pump";
import { writeJsonAtomic } from "../src/fsutil";
import { latestPath } from "../src/link/paths";
import { attentionGroups, attentionText, unavailableDetail } from "../orca-plugin/src/panel/model";
import { renderStatusPage } from "../orca-plugin/src/panel";
import { createTask } from "../src/tasks/store";
import { taskStatus } from "../src/tasks/api";
import { fakeCtx } from "./helpers";
const failure = (id:string, extra:Partial<TaskData>={}):TaskData=>({id,state:"failed",goal:id,executor:"agy",backend:"direct",worktree:null,updatedAt:1000,...extra});
test("dismissed, expired and successfully retried failures leave attention",()=>{
  const s=emptySnapshot();
  s.tasks=[failure("dismissed",{dismissed:true}),failure("old",{updatedAt:1}),failure("original"),failure("retry",{state:"done",retryOf:"original"})];
  expect(attentionGroups(s,300000)).toEqual([]);
});
test("broken failures share one attention group",()=>{
 const s=emptySnapshot();
 s.tasks=[failure("t-1",{brokenExecutor:"agy",brokenReason:"bad argv"}),failure("t-2",{brokenExecutor:"agy",brokenReason:"bad argv"})];
 const groups=attentionGroups(s,1200);expect(groups).toHaveLength(1);
 expect(attentionText(groups[0],1200)).toBe("Antigravity is not working: bad argv · 2 tasks affected");
});
test("live runners and started attempts never appear as waiting for executor",()=>{
  const s=emptySnapshot();
  s.tasks=[failure("live",{state:"running",executor:null,runnerAlive:true}),failure("started",{state:"running",executor:null,attemptStartedAt:1000}),failure("stuck",{state:"queued",executor:null,runnerAlive:false})];
  expect(attentionGroups(s,1700).map(g=>g.latest.id)).toEqual(["stuck"]);
});
test("queued task is not declared stuck before ten minutes",()=>{
  const ctx=fakeCtx();const t=createTask(ctx,{brief:{goal:"g",repo:"/r"},kind:null,requestedExecutor:null,timeoutS:60});
  expect(taskStatus({...ctx,now:ctx.now+599},t.id)?.state).toBe("queued");
  expect(taskStatus({...ctx,now:ctx.now+601},t.id)?.state).toBe("failed");
});
test("snapshot roundtrip retains current attempt and dismissal",()=>{
  const ctx=fakeCtx();const t=createTask(ctx,{brief:{goal:"g",repo:"/r"},kind:null,requestedExecutor:null,timeoutS:60});
  Object.assign(t,{state:"running",executor:"codex",backend:"orca",attemptStartedAt:2000,runnerPid:process.pid,dismissed:true,retryOf:"previous"});
  const d=taskData(t);const s=emptySnapshot();s.tasks=[d];
  expect(parseSnapshot(s)?.tasks[0]).toMatchObject({executor:"codex",backend:"orca",attemptStartedAt:2000,runnerAlive:true,dismissed:true,retryOf:"previous"});
});
test("pump publishes dismissal even when task state has not changed",async()=>{
  const ctx=fakeCtx();const t=createTask(ctx,{brief:{goal:"g",repo:"/r"},kind:null,requestedExecutor:null,timeoutS:60});t.state="failed";
  const s=emptySnapshot();s.tasks=[taskData(t)];writeJsonAtomic(latestPath(ctx),s);t.dismissed=true;
  const events=await pumpOnce(ctx,{tasks:()=>[t],status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"claude-code",mode:"normal",disabled: false, paused: null, modeHold: null,calendarPace:true,providers:[],executors:{ranked:[],excluded:[]}}),publish:async()=>({seq:1,transports:["outbox"],errors:[]})});
  expect(events.find(e=>e.type==="task")?.data).toMatchObject({dismissed:true});
});
test("broken executor detail identifies why it is unavailable",()=>{
  expect(unavailableDetail({id:"agy",verdict:"OK",usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false,brokenReason:"bad argv"},1000)).toBe("Not working · bad argv");
});

test("an active retry clears original attention and appears in Running",()=>{
 const s=emptySnapshot();s.tasks=[failure("old",{retriedBy:"new"}),failure("new",{state:"running",retryOf:"old",executor:"codex",attemptStartedAt:1100})];
 expect(attentionGroups(s,1200)).toEqual([]);
 const html=renderStatusPage(s,{nowS:1200,reachable:true,transport:"http"});expect(html).toContain("<h2>Running</h2>");expect(html).toContain("Codex");expect(html).toContain("new");
});

test("partial work appears on the status page for review with worktree",()=>{
 const s=emptySnapshot();
 s.budget={generatedAt:1000,strategy:"default",planner:"claude-code",mode:"normal",providers:[{id:"codex",verdict:"OK",usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false}],ranked:[{id:"codex",verdict:"OK"}]};
 s.tasks=[failure("review",{state:"partial",worktree:"/work/review"})];
 const groups=attentionGroups(s,1200);expect(groups).toHaveLength(1);
 expect(attentionText(groups[0],1200)).toBe("Needs review on Antigravity");
 const html=renderStatusPage(s,{nowS:1200,reachable:true,transport:"http"});
 expect(html).toContain("<h2>Waiting for review</h2>");expect(html).toContain("/work/review");
 expect(html).toContain("pacer review &lt;id&gt;");expect(html).not.toContain("data-command");
});

for(const state of ["partial","failed","limit","stopped"] as const) test(`retry ending ${state} keeps original hidden and chain count`,()=>{
 const s=emptySnapshot();s.tasks=[failure("old",{goal:"fix",retriedBy:"new"}),failure("new",{goal:"fix",state,retryOf:"old",updatedAt:1100})];
 const groups=attentionGroups(s,1200);
 if(state==="stopped")expect(groups).toEqual([]);
 else {expect(groups).toHaveLength(1);expect(groups[0].latest.id).toBe("new");expect(groups[0].tasks.map(t=>t.id)).toEqual(["new"]);if(state!=="partial")expect(attentionText(groups[0],1200)).toContain("twice");}
});

test("retry chains keep xN counts and tolerate cycles",()=>{
 const s=emptySnapshot();s.tasks=[failure("a",{goal:"fix",retriedBy:"b"}),failure("b",{goal:"fix",retryOf:"a",retriedBy:"c"}),failure("c",{goal:"fix",retryOf:"b",updatedAt:1100})];
 expect(attentionText(attentionGroups(s,1200)[0],1200)).toBe("Failed ×3 on Antigravity");
 s.tasks[0].retryOf="c";
 expect(attentionText(attentionGroups(s,1200)[0],1200)).toBe("Failed ×3 on Antigravity");
});
