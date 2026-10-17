import { expect, test } from "bun:test";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import { apiTask } from "../src/api/read-model/tasks";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture, record } from "./read-model-helpers";
import { fakeCtx } from "./helpers";

const ctx = fakeCtx();
function input(): RuleInput { return { now: ctx.now, tasks: [], executors: [], accounts: [], planner: null, setup: { complete: true, open: 0, items: [] }, update: null, retryTarget: () => null }; }
const task = (state: Parameters<typeof record>[0], at = ctx.now) => apiTask(ctx, record(state, at));
test("review raises for unreviewed done and partial tasks and clears on verdict", () => {
 for (const state of ["done", "partial"] as const) {
  const t = task(state);
  expect(deriveItems({...input(),tasks:[t]})[0]).toMatchObject({id:`review:${t.id}`,actions:[{op:"ui.open",params:{view:"review",id:t.id}},{op:"task.review",params:{id:t.id,verdict:"accept"}}]});
  expect(deriveItems({...input(),tasks:[{...t,review:{accepted:true,at:ctx.now,kind:null,note:null}}]})).toEqual([]);
 }
});
test("planner reviews wait 600 seconds for every planner", () => {
 for (const runner of ["claude-code", "codex", "cursor", "opencode"]) {
  const {s,st} = capacityFixture(runner);
  const planner = buildReadModel(ctx,{strategy:s,status:st,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,items:[]}}).planner;
  const t = {...task("done",ctx.now-599),source:"planner" as const};
  expect(deriveItems({...input(),planner,tasks:[t]})).toEqual([]);
  expect(deriveItems({...input(),planner,now:ctx.now+1,tasks:[t]})[0]?.id).toBe(`review:${t.id}`);
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
 const items=deriveItems({...input(),tasks:[task("done"),task("failed",ctx.now-10),idle,task("failed",ctx.now-20)]});
 expect(items.map(i=>i.kind)).toEqual(["stuck","failed","failed","review"]);
 expect(items[1]?.since).toBeLessThan(items[2]!.since);
 expect(items[0]?.actions[0]).toMatchObject({op:"ui.open",label:"Open task"});
 expect(deriveItems({...input(),tasks:[{...idle,progress:{...idle.progress,phase:"testing"}}]})).toEqual([]);
});
test("condition rules raise and clear with required enabled data", () => {
 const {s,st}=capacityFixture();
 const model=buildReadModel(ctx,{strategy:s,status:st,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,items:[]}});
 const executor={...model.executors.find(e=>e.rank!=="planner")!,state:"down" as const};
 expect(deriveItems({...input(),executors:[executor]})[0]?.kind).toBe("executor_down");
 expect(deriveItems({...input(),executors:[{...executor,enabled:false}]})).toEqual([]);
 expect(deriveItems({...input(),executors:[{...executor,rank:"planner"}]})).toEqual([]);
 expect(deriveItems({...input(),executors:[{...executor,state:"ready"}]})).toEqual([]);
 const account={...model.accounts.find(a=>a.name===executor.account)!,signedIn:false};
 expect(deriveItems({...input(),accounts:[account],executors:[{...executor,state:"ready"}]})[0]?.kind).toBe("account_signin");
 expect(deriveItems({...input(),accounts:[{...account,signedIn:true}],executors:[{...executor,state:"ready"}]})).toEqual([]);
 expect(deriveItems({...input(),accounts:[account]})).toEqual([]);
 for(const [verdict,mode,raised] of [["ahead","strict",true],["ahead","emergency",true],["ahead","normal",false],["out","normal",true],["on_pace","strict",false]] as const) {
  const items=deriveItems({...input(),planner:{...model.planner!,verdict,mode}});
  expect(items.length).toBe(raised?1:0);if(raised)expect(items[0]?.actions.map(a=>a.op)).toEqual(["ui.open"]);
 }
 const setup={complete:false,open:1,items:[{id:"service",title:"Service",status:"pending",required:true},{id:"optional",title:"Optional",status:"pending",required:false}]};
 expect(deriveItems({...input(),setup})[0]).toMatchObject({id:"setup:service",notify:"all"});
 expect(deriveItems({...input(),setup:{...setup,items:setup.items.map(i=>({...i,status:"done"}))}})).toEqual([]);
 expect(deriveItems({...input(),update:{latest:"9.0",available:true}})[0]).toMatchObject({id:"update:9.0",notify:"all"});
 expect(deriveItems({...input(),update:{latest:"9.0",available:false}})).toEqual([]);
});
