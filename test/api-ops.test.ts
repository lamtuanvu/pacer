import { withLoginIndicators } from "./helpers";
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callOp, opNames } from "../src/api/ops";
import { httpStatus, toApiError } from "../src/api/protocol";
import { createTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

async function ctxWithStrategy() {
  const ctx = withLoginIndicators(fakeCtx());
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return toApiError(e).code; } };

test("the registry names the task operations", () => {
  expect(opNames()).toEqual(expect.arrayContaining(["task.get", "task.list", "task.delegate", "task.wait", "task.stop", "task.retry", "task.review", "task.dismiss", "activity.list"]));
});

test("task.get returns detail and task.list keeps summaries", async () => {
  const ctx = await ctxWithStrategy();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(await callOp(ctx, "task.get", { id: t.id })).toMatchObject({ id: t.id, state: "queued", brief: { goal: "g" } });
  expect((await callOp(ctx, "task.list", {})) as unknown).toMatchObject({tasks:expect.any(Array),next:null});
});

test("task.delegate uses the injected spawner and validates its brief", async () => {
  const ctx = await ctxWithStrategy(), spawned: string[] = [];
  const r = await callOp(ctx, "task.delegate", { goal: "g", repo: tmpDir() }, { spawnRunner: (_c, id) => { spawned.push(id); return 1; } }) as { task_id: string };
  expect(spawned).toEqual([r.task_id]);
  expect(await codeOf(callOp(ctx, "task.delegate", { goal: "", repo: "rel" }, { spawnRunner: () => 1 }))).toBe("invalid_input");
});

test("unknown ops, bad params and unknown tasks map to their codes and statuses", async () => {
  const ctx = await ctxWithStrategy();
  expect(await codeOf(callOp(ctx, "task.nope", {}))).toBe("unknown_op");
  expect(await codeOf(callOp(ctx, "task.get", { id: 5 }))).toBe("invalid_input");
  expect(await codeOf(callOp(ctx, "task.get", { id: "missing" }))).toBe("unknown_task");
  expect([httpStatus("invalid_input"), httpStatus("unknown_task"), httpStatus("unknown_op"), httpStatus("conflict"), httpStatus("too_large"), httpStatus("internal")]).toEqual([400, 404, 404, 409, 413, 500]);
});

test("task.dismiss reports unknown ids", async () => {
  const ctx = await ctxWithStrategy();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  expect(await callOp(ctx, "task.dismiss", { ids: [t.id, "missing"] })).toEqual({ dismissed: [t.id], unknown: ["missing"] });
});

test("every planned operation is registered", () => {
  expect(opNames()).toEqual(expect.arrayContaining(["host.check", "host.list", "limits.check", "limits.report", "routing.route", "routing.status", "runner.block", "runner.list", "runner.unblock", "strategy.list", "strategy.use",
    "task.delegate", "task.diff", "task.dismiss", "task.get", "task.list", "task.log", "task.retry", "task.review", "task.stop", "task.wait"]));
});

test("runner.block validates the executor through core", async () => {
  const ctx = await ctxWithStrategy();
  expect(await callOp(ctx, "runner.block", { id: "codex", for: "1h" })).toEqual({ ok: true });
  expect(await codeOf(callOp(ctx, "runner.block", { id: "gemini" }))).toBe("unknown_executor");
});

test("log offsets, route kinds and strategy errors are validated", async () => {
  const ctx = await ctxWithStrategy();
  for (const stdout of [-1, 0.5]) expect(await codeOf(callOp(ctx, "task.log", { id: "missing", stdout }))).toBe("invalid_input");
  expect(await codeOf(callOp(ctx, "task.log", { id: "missing", stderr: -1 }))).toBe("invalid_input");
  expect(await codeOf(callOp(ctx, "routing.route", { kind: "invalid-kind" }))).toBe("invalid_input");
  expect(await codeOf(callOp(ctx, "strategy.use", { name: "missing" }))).toBe("invalid_input");
});

test("task.diff validates its optional path", async () => {
  const ctx = await ctxWithStrategy();
  for (const path of ["", "a\0b", "x".repeat(4097), 1]) {
    expect(await codeOf(callOp(ctx, "task.diff", { id: "missing", path }))).toBe("invalid_input");
  }
  expect(await codeOf(callOp(ctx, "task.diff", { id: "missing", path: "a.txt" }))).toBe("unknown_task");
});

test("attention dismiss is idempotent for concurrent clients and dismisses a review task", async () => {
 const {updateTask,readTask}=await import("../src/tasks/store");
 const ctx=await ctxWithStrategy(),t=createTask(ctx,{brief:{goal:"review me",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,t=>{t.state="done";t.reviewRequest={note:"Inspect",at:ctx.now};});
 const id=`review:${t.id}`;
 expect(await Promise.all([callOp(ctx,"attention.dismiss",{id}),callOp(ctx,"attention.dismiss",{id})])).toEqual([{dismissed:true},{dismissed:true}]);
 expect(readTask(ctx,t.id)?.dismissed).toBe(true);
 expect(await codeOf(callOp(ctx,"attention.dismiss",{id:"review:missing"}))).toBe("unknown_task");
});
test("attention snooze validates duration and returns its expiry",async()=>{
 const {updateTask}=await import("../src/tasks/store");
 const ctx=await ctxWithStrategy(),t=createTask(ctx,{brief:{goal:"review me",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,t=>{t.state="done";t.reviewRequest={note:"Inspect",at:ctx.now};});
 expect(await callOp(ctx,"attention.snooze",{id:`review:${t.id}`,for:"1h"})).toEqual({until:ctx.now+3600});
 expect(await codeOf(callOp(ctx,"attention.snooze",{id:`review:${t.id}`,for:"2h"}))).toBe("invalid_input");
});

test("setup attention can be dismissed before a strategy is configured",async()=>{
 const ctx=withLoginIndicators(fakeCtx());
 const {liveSnapshot}=await import("../src/api/events");
 const status=async()=>{throw new Error("not configured");};
 const before=await liveSnapshot(ctx,{status});
 const item=before.snapshot.attention.find(i=>i.kind==="setup")!;
 expect(item).toBeDefined();
 expect(await callOp(ctx,"attention.dismiss",{id:item.id})).toEqual({dismissed:true});
 expect((await liveSnapshot(ctx,{status})).snapshot.attention.some(i=>i.id===item.id)).toBe(false);
});

test("task reads leave waiting work and revisions unchanged", async () => {
  const {updateTask} = await import("../src/tasks/store");
  const ctx = await ctxWithStrategy(), spawned: string[] = [];
  const make = (goal: string) => {
    const t = createTask(ctx, {brief: {goal, repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 60});
    return updateTask(ctx, t.id, x => {x.queue = {reason: "no_slot", since: ctx.now, position: 1};});
  };
  const a = make("a"), deps = {spawnRunner: (_: unknown, id: string) => {spawned.push(id); return process.pid;}};
  expect(await callOp(ctx, "task.get", {id: a.id}, deps)).toMatchObject({state: "queued"});
  expect((await import("../src/tasks/store")).readTask(ctx,a.id)?.rev).toBe(a.rev);
  updateTask(ctx, a.id, t => {t.state = "done";});
  const b = make("b");
  await callOp(ctx, "task.list", {}, deps);
  expect(spawned).toEqual([]);
  const {readTask} = await import("../src/tasks/store");
  expect(readTask(ctx, b.id)?.state).toBe("queued");
});

test('update.apply refuses source installs and exposes advancing job steps',async()=>{
 const ctx=await ctxWithStrategy();
 expect(await codeOf(callOp(ctx,'update.apply',{}, {update:{standalone:false}}))).toBe('not_allowed');
 const result=await callOp(ctx,'update.apply',{}, {update:{standalone:true},runUpdate:async(_o,d)=>{
  for(const name of ['Download','Verify','Replace','Refresh integrations','Restart'] as const) {d.progress?.(name,'running');d.progress?.(name,'passed');}
  return {code:0,out:'updated',err:''};
 }}) as any;
 expect(result.job.state).toBe('passed');expect(result.job.steps.map((s:any)=>s.state)).toEqual(Array(5).fill('passed'));
});
test('runner mutations are exposed and validate input',async()=>{
 const ctx=withLoginIndicators(fakeCtx());mkdirSync(ctx.pacerHome,{recursive:true});await Bun.write(join(ctx.pacerHome,'strategy.yaml'),'planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrouting:\n  - kinds: [docs]\n    executors: [codex]\n  - default: [codex]\n');
 expect(await callOp(ctx,'runner.set',{id:'codex',enabled:false})).toMatchObject({id:'codex',warnings:expect.any(Array)});
 expect(await codeOf(callOp(ctx,'runner.reorder',{ids:[]}))).toBe('invalid_input');
 expect(await codeOf(callOp(ctx,'runner.set',{id:'codex',max_tasks:0}))).toBe('invalid_input');
 expect(await callOp(ctx,'runner.add',{agent:'cursor',kinds:['docs'],test:false,max_tasks:2,rank:0})).toEqual({id:'cursor'});
});

test('update restart is confirmed on boot by the installed version',async()=>{
 const {recoverJobs,getJob}=await import('../src/jobs/registry');
 const {currentVersion}=await import('../src/update/version');const ctx=await ctxWithStrategy();
 const {job}=await callOp(ctx,'update.apply',{}, {update:{standalone:true},runUpdate:async(_o,d)=>{
  for(const name of ['Download','Verify','Replace','Refresh integrations'] as const) d.progress?.(name,'passed');
  d.progress?.('Restart','running',currentVersion());return {code:0,out:'',err:''};
 }}) as any;
 expect(job.state).toBe('running');recoverJobs(ctx);expect(getJob(ctx,job.id)).toMatchObject({state:'passed',steps:expect.arrayContaining([{name:'Restart',state:'passed',detail:currentVersion()}])});
});
test('strategy.build op uses the selected planner and returns terminal result',async()=>{
 const ctx=await ctxWithStrategy();expect(await callOp(ctx,'strategy.build',{agent:'cursor',from:'default',brief:'Help'}, {openTerminal:async(_c,o)=>{
 expect(o.argv[0]).toBe('cursor-agent');expect(o.argv[1]).toContain('Help');return {opened:true,target:'terminal',command:'safe command'};
 }})).toEqual({opened:true,target:'terminal',command:'safe command'});
});

test("short titles are additive across delegate, get and both list forms",async()=>{
 const ctx=await ctxWithStrategy(),goal="Fix queue. Then verify every runner";
 const r=await callOp(ctx,"task.delegate",{goal,repo:ctx.home,title:"  Queue fix  "},{spawnRunner:()=>1}) as {task_id:string};
 expect(r).toMatchObject({title:"Queue fix",goal});
 expect(await callOp(ctx,"task.get",{id:r.task_id})).toMatchObject({title:"Queue fix",brief:{goal}});
 // 3.0: task.list always pages; the 2.x bare array is served by the /v2 adapter (pinned by the protocol-v2 goldens).
 expect(await callOp(ctx,"task.list",{})).toMatchObject({tasks:expect.arrayContaining([expect.objectContaining({title:"Queue fix"})])});
 expect(await callOp(ctx,"task.list",{states:["queued"]})).toMatchObject({tasks:[{title:"Queue fix"}]});
 for(const title of [" ","x".repeat(61)])expect(await codeOf(callOp(ctx,"task.delegate",{goal,repo:ctx.home,title},{spawnRunner:()=>1}))).toBe("invalid_input");
 const old=createTask(ctx,{brief:{goal,repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 expect(await callOp(ctx,"task.get",{id:old.id})).toMatchObject({title:"Fix queue"});
 expect(await callOp(ctx,"task.list",{})).toMatchObject({tasks:expect.arrayContaining([expect.objectContaining({id:old.id,title:"Fix queue"})])});
});
