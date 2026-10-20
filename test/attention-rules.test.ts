import { expect, test } from "bun:test";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import { apiTask } from "../src/api/read-model/tasks";
import { deriveTaskItems } from "../src/core/task-attention";
import { buildCounts } from "../src/api/read-model/summary";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture, record } from "./read-model-helpers";
import { fakeCtx } from "./helpers";

const ctx = fakeCtx();
function input(): RuleInput { return { now: ctx.now, tasks: [], executors: [], accounts: [], planner: null, setup: { complete: true, open: 0, items: [] }, update: null, retryTarget: () => null }; }
const task = (state: Parameters<typeof record>[0], at = ctx.now) => apiTask(ctx, record(state, at));
test("unanswered needs_input raises a blocked question and clears after answering or stopping", () => {
 const raw=record("needs_input",ctx.now);
 raw.question={text:'which db? $(echo no)\n' + "x".repeat(220),at:ctx.now-10};
 const t=apiTask(ctx,raw);
 expect(deriveItems({...input(),tasks:[t]})[0]).toMatchObject({id:`question:${t.id}`,kind:"question",severity:"blocked",notify:"important",detail:raw.question.text.slice(0,200),since:raw.question.at,actions:[{label:"Answer",op:"task.answer",params:{id:t.id}},{label:"Stop",op:"task.stop",params:{id:t.id}}]});
 for(const patch of [{question:{...raw.question,answer:"postgres"}},{retriedBy:"next"},{dismissed:true},{state:"stopped"}]) expect(deriveItems({...input(),tasks:[{...t,...patch}]})).toEqual([]);
});
test("ordinary completions never escalate for missing verdicts", () => {
 for (const acceptanceState of ["passed", "none", "pending"] as const) {
  for (const elapsed of [0, 600, 86400]) {
   const t = {...task("done"), source: "planner" as const, acceptanceState};
   expect(deriveItems({...input(), now: ctx.now + elapsed, tasks: [t]})).toEqual([]);
  }
 }
});
test("only explicit review requests raise a decision; failures and incomplete work take precedence", () => {
 const request = {note:"Check the permission change", at:ctx.now};
 const t = {...task("done"), reviewRequest: request};
 expect(deriveItems({...input(),tasks:[t]})[0]).toMatchObject({kind:"review",detail:request.note,actions:[{label:"Review changes",op:"ui.open"}]});
 for (const [state, acceptanceState, detail] of [["done","failed","Acceptance checks failed"],["partial","none","Execution is incomplete"],["partial","failed","Acceptance checks failed"]] as const) {
  const current = {...t,state,acceptanceState};
  const items = deriveItems({...input(),tasks:[current]});
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({kind:"failed",severity:"problem",detail});
  expect(items[0]!.actions.some(a=>a.op==="task.review")).toBe(false);
  for (const patch of [{review:{accepted:true,at:ctx.now,kind:null,note:null}},{resolved:"reviewed"},{dismissed:true},{retriedBy:"next"}]) {
   expect(deriveItems({...input(),tasks:[{...current,...patch}]})).toEqual([]);
  }
 }
});
test("failed and limit offer a concrete retry and clear on retry, dismissal or review", () => {
 for (const state of ["failed","limit"] as const) {
  const t=task(state), i={...input(),tasks:[t],retryTarget:()=>"cursor#cursor"};
  expect(deriveItems(i)[0]).toMatchObject({id:`${state}:${t.id}`,actions:[{label:"Retry on Cursor",op:"task.retry",params:{id:t.id,executor:"cursor#cursor"}},{label:"See error",op:"ui.open"}]});
  for (const patch of [{retriedBy:"next"},{dismissed:true},{review:{accepted:false,at:ctx.now,kind:null,note:null}}]) expect(deriveItems({...i,tasks:[{...t,...patch}]})).toEqual([]);
  expect(deriveItems({...i,retryTarget:()=>null})[0]?.actions[0]).toMatchObject({label:"Retry",params:{id:t.id}});
 }
 expect(deriveItems({...input(),tasks:[task("stopped")]})).toEqual([]);
});
test("idle tasks are blocked and sort before failures then reviews, oldest first", () => {
 const idle={...task("running"),progress:{phase:"idle",lastOutputAt:ctx.now-600,files:0,commits:0,logBytes:0}};
 const items=deriveItems({...input(),tasks:[{...task("done"),reviewRequest:{note:"Inspect",at:ctx.now}},task("failed",ctx.now-10),idle,task("failed",ctx.now-20)]});
 expect(items.map(i=>i.kind)).toEqual(["stuck","failed","failed","review"]);
 expect(items[1]?.since).toBeLessThan(items[2]!.since);
 expect(items[0]?.actions[0]).toMatchObject({op:"ui.open",label:"Open task"});
 expect(deriveItems({...input(),tasks:[{...idle,progress:{...idle.progress,phase:"testing"}}]})).toEqual([]);
});
test("condition rules raise and clear with required enabled data", () => {
 const {s,st}=capacityFixture();
 const model=buildReadModel(ctx,{strategy:s,status:st,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,ready:false,items:[]}});
 const executor={...model.executors.find(e=>e.rank!=="planner")!,state:"down" as const};
 expect(deriveItems({...input(),executors:[executor]})[0]?.kind).toBe("executor_down");
 expect(deriveItems({...input(),executors:[{...executor,enabled:false}]})).toEqual([]);
 expect(deriveItems({...input(),executors:[{...executor,rank:"planner"}]})).toEqual([]);
 expect(deriveItems({...input(),executors:[{...executor,state:"ready"}]})).toEqual([]);
 const account={...model.accounts.find(a=>a.name===executor.account)!,signedIn:false};
 expect(deriveItems({...input(),accounts:[account],executors:[{...executor,state:"ready"}]})[0]?.kind).toBe("account_signin");
 expect(deriveItems({...input(),accounts:[{...account,signedIn:true}],executors:[{...executor,state:"ready"}]})).toEqual([]);
 expect(deriveItems({...input(),accounts:[account]})).toEqual([]);
 for(const [verdict,mode,raised] of [["ahead","strict",false],["ahead","emergency",false],["ahead","normal",false],["out","normal",true],["on_pace","strict",false]] as const) {
  const items=deriveItems({...input(),planner:{...model.planner!,verdict,mode}});
  expect(items.length).toBe(raised?1:0);if(raised)expect(items[0]?.actions.map(a=>a.op)).toEqual(["ui.open","mode.hold"]);
 }
 const setup={complete:false,open:1,items:[{id:"service",title:"Service",status:"pending" as const,required:true},{id:"optional",title:"Optional",status:"pending" as const,required:false}]};
 expect(deriveItems({...input(),setup})[0]).toMatchObject({id:"setup:service",notify:"all"});
 expect(deriveItems({...input(),setup:{...setup,items:setup.items.map(i=>({...i,status:"done"}))}})).toEqual([]);
 expect(deriveItems({...input(),update:{latest:"9.0",available:true}})[0]).toMatchObject({id:"update:9.0",notify:"all"});
 expect(deriveItems({...input(),update:{latest:"9.0",available:false}})).toEqual([]);
});

test("quota hold clears attention and sign-in actions name their concrete targets",()=>{
 const {s,st}=capacityFixture();
 const model=buildReadModel(ctx,{strategy:s,status:st,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,ready:false,items:[]}});
 const planner={...model.planner!,verdict:"out" as const,modeHeldUntil:ctx.now+60};
 expect(deriveItems({...input(),planner})).toEqual([]);
 expect(deriveItems({...input(),planner:{...planner,modeHeldUntil:ctx.now}})[0]?.actions[1]).toEqual({label:"Keep normal",op:"mode.hold",params:{mode:"normal"}});
 const executor=model.executors.find(e=>e.rank!=="planner")!,account=model.accounts.find(a=>a.name===executor.account)!;
 expect(deriveItems({...input(),executors:[executor],accounts:[{...account,signedIn:false}]})[0]?.actions).toEqual([{label:"Sign in",op:"account.signin",params:{name:account.name}},{label:"Disable",op:"runner.set",params:{id:executor.id,enabled:false}}]);
});

test("queued tasks waiting for a slot or pause never need attention, even after 600 seconds",()=>{
 for(const reason of ["no_slot","paused"] as const) {
  const t={...task("queued",ctx.now-3600),queue:{reason,since:ctx.now-3600,position:1},progress:{phase:"idle",lastOutputAt:ctx.now-3600,files:0,commits:0,logBytes:0}};
  expect(deriveItems({...input(),tasks:[t]})).toEqual([]);
 }
});
test("superseded failed and partial attempts contribute no duplicate attention",()=>{
 for(const state of ["failed","partial"] as const) for(const nextState of ["queued","running","done"] as const) {
  const original=task(state,ctx.now-1200),next={...task(nextState,ctx.now-700),retryOf:original.id};
  const items=deriveTaskItems({...input(),tasks:[original,next]});
  expect(items.map(i=>i.taskId)).toEqual([]);
  expect(buildCounts([original,next],[],input().setup,[],items)).toMatchObject({attention:0,review:0});
  expect(deriveTaskItems({...input(),tasks:[{...original,retriedBy:next.id},next]})).toHaveLength(0);
 }
});
test("task attention titles use the short task title",()=>{
 const raw=record("failed",ctx.now,{title:"Queue fix"});
 expect(deriveTaskItems({...input(),tasks:[apiTask(ctx,raw)]})[0]?.title).toBe("Queue fix");
});

test("dismissed or stopped retries restore the original attention",()=>{
 for(const state of ["failed","partial"] as const) for(const retry of ["dismissed","stopped","missing"] as const) for(const forward of [false,true]) {
  const original=task(state,ctx.now-1200), next={...task(retry==="stopped"?"stopped":"running",ctx.now-700),retryOf:original.id,dismissed:retry==="dismissed"};
  const tasks=[{...original,...(forward?{retriedBy:next.id}:{})},...(retry==="missing"?[]:[next])];
  const items=deriveTaskItems({...input(),tasks});
  // A forward link to a retry not yet in the snapshot still hides the original, so clients drop it at once.
  const hidden=retry==="missing"&&forward;
  expect(items.map(i=>i.taskId)).toEqual(hidden?[]:[original.id]);
  expect(buildCounts(tasks,[],input().setup,[],items)).toMatchObject({attention:hidden?0:1,review:0});
 }
});

test("ahead-of-pace advice stays on the planner without inflating attention counts", () => {
 for (const mode of ["normal", "strict", "emergency"] as const) {
  const {s,st}=capacityFixture();
  st.mode=mode;
  const provider=st.providers.find(p=>p.id===st.planner)!;
  provider.verdict="AHEAD";
  provider.binding={...provider.binding!,usedPct:90,pace:50,verdict:"AHEAD"};
  const base={strategy:s,status:st,hosts:[],setup:{complete:true,checkedAt:ctx.now,ready:false,items:[]}};
  const model=buildReadModel(ctx,{...base,tasks:[]});
  expect(model.planner).toMatchObject({verdict:"ahead",mode,advice:"40 pts ahead of pace — delegate more."});
  expect(model.attention).toEqual([]);
  expect(model.counts).toMatchObject({attention:0,problems:0});

  const failed=task("failed");
  const actionable=buildReadModel(ctx,{...base,tasks:[failed]});
  expect(actionable.attention.map(i=>i.kind)).toEqual(["failed"]);
  expect(actionable.counts).toMatchObject({attention:1,problems:1});
  expect(actionable.counts.byRepo[failed.repo.key]?.attention).toBe(1);
 }
});

test("review counts count decisions, not failing requested tasks",()=>{
 const t={...task("partial"),reviewRequest:{note:"Inspect",at:ctx.now}};
 const items=deriveTaskItems({...input(),tasks:[t]});
 expect(buildCounts([t],[],input().setup,[],items)).toMatchObject({attention:1,problems:1,review:0});
});
