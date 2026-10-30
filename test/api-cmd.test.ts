import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { cmdToOp, runMappedCmd } from "../src/api/cmd";
import { ApiError } from "../src/api/client";
import { CoreError } from "../src/core/errors";
import { consoleCommands, type ConsoleDeps } from "../src/console/console";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

async function ctxWithStrategy() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}

test("runMappedCmd reports success and errors and skips unmapped commands", async () => {
  const ctx = await ctxWithStrategy();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const call = (op: string, p: unknown) => callOp(ctx, op, p);
  expect(await runMappedCmd(call, { cmd: "stop", taskId: t.id })).toEqual({ handled: true, ok: true, message: `${t.id} stopped` });
  expect(readTask(ctx, t.id)?.state).toBe("stopped");
  expect(await runMappedCmd(call, { cmd: "stop", taskId: "missing" })).toMatchObject({ handled: true, ok: false, message: expect.stringMatching(/^pacer: .*missing/) });
  expect(await runMappedCmd(call, { cmd: "refresh" })).toEqual({ handled: false });
});

test("mapped stop reports pending while a provider-owned executor may still run", async () => {
  const ctx = await ctxWithStrategy();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null,
    requestedExecutor: "codex", timeoutS: 60 });
  updateTask(ctx, task.id, current => {
    current.state = "running";
    current.executor = "codex";
    current.executorProvider = "pacer-exec-direct";
  });
  const result = await runMappedCmd((op, params) => callOp(ctx, op, params), { cmd: "stop", taskId: task.id });
  expect(result).toEqual({ handled: true, ok: true, message: `${task.id} stop pending` });
  expect(readTask(ctx, task.id)?.state).toBe("running");
  expect(readTask(ctx, task.id)?.stopPending).toBeDefined();
});

for (const ErrorType of [ApiError, CoreError]) test(`runMappedCmd preserves ${ErrorType.name} hints`, async () => {
  const call = async () => { throw new ErrorType("conflict", "retry already queued", "wait for it"); };
  expect(await runMappedCmd(call, { cmd: "retry", taskId: "t1" })).toEqual({ handled: true, ok: false, message: "pacer: retry already queued (wait for it)" });
});

test("runMappedCmd rethrows unexpected errors", async () => {
  const error = new Error("unexpected");
  await expect(runMappedCmd(async () => { throw error; }, { cmd: "stop", taskId: "t1" })).rejects.toBe(error);
});

test("console runs mapped commands through ops", async () => {
  const ctx = await ctxWithStrategy();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const printed: string[] = [];
  const deps: ConsoleDeps = {
    delegate() { throw new Error("unused"); }, useStrategy() { throw new Error("unused"); },
    listStrategies: () => [], statusText: async () => "", pump: async () => [], heartbeat() {},
    resolveWorktreePath: async () => null, selfHandle: async () => ({ handle: null, paneKey: null }),
    every: () => () => {}, pid: 1, cwd: ctx.home,
  };
  let refreshed = 0;
  const command = consoleCommands(ctx, deps, (s) => printed.push(s), { startDelegate() {}, chooseStrategy() {}, use: async () => {}, refresh: async () => { refreshed++; } });
  await command({ cmd: "stop", taskId: t.id });
  expect(readTask(ctx, t.id)?.state).toBe("stopped");
  expect(printed.at(-1)).toBe(`${t.id} stopped`);
  await command({ cmd: "stop", taskId: "missing" });
  expect(printed.at(-1)).toBe("pacer: unknown task");
  expect(refreshed).toBe(2);
});

test("retry mapping opts console commands into panel semantics", () => {
  const retry = { cmd: "retry" as const, taskId: "t1", executor: "codex" };
  expect(cmdToOp(retry, { fromPanel: true })).toEqual({ op: "task.retry", params: { id: "t1", executor: "codex", from_panel: true } });
  expect(cmdToOp(retry)?.params.from_panel ?? false).toBe(false);
});

 test("every non-local console command maps to a v2 op", () => {
  for (const cmd of (["check-setup","check-updates","update","delegate","retry","retry-all","dismiss","block","unblock","stop","use","strategy-build","notify-level","config-set","account-remove","runner-remove","open-terminal"] as const)) {
   expect(cmdToOp({cmd}), cmd).not.toBeNull();
  }
  expect(cmdToOp({cmd:"delegate",goal:"fix",path:"/repo"})).toEqual({op:"task.delegate",params:{goal:"fix",repo:"/repo",source:"ui"}});
 });
 test("task.retry_all retries two tasks and skips an active retry", async () => {
  const ctx=await ctxWithStrategy();
  const tasks=Array.from({length:3},()=>createTask(ctx,{brief:{goal:"g",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60}));
  await callOp(ctx,"task.retry",{id:tasks[1].id},{spawnRunner:()=>{}});
  const result=await callOp(ctx,"task.retry_all",{ids:tasks.map(t=>t.id)},{spawnRunner:()=>{}}) as any;
  expect(result.retried.map((r:any)=>r.of.task_id)).toEqual([tasks[0].id,tasks[2].id]);
  expect(result.skipped).toEqual([{id:tasks[1].id,reason:"retry already running"}]);
 });

test("interactive settings commands use the terminal opener through ops",async()=>{
 const ctx=await ctxWithStrategy();
 for(const command of ["account-add","account-add-orca","runner-add","init"] as const){
  const mapped=cmdToOp({cmd:"open-terminal",command,worktreeId:"wt-1"})!;
  const opened:unknown[]=[];
  const result=await callOp(ctx,mapped.op,mapped.params,{openTerminal:async(_ctx,options)=>{opened.push(options);return {opened:true,target:"orca",command:"safe"};}});
  expect(result).toMatchObject({opened:true});expect(opened).toEqual([expect.objectContaining({worktree:"id:wt-1",title:"pacer settings"})]);
 }
});

test("config mapping preserves planner integration changes",()=>{
 expect(cmdToOp({cmd:"config-set",key:"planner",value:"codex"})).toEqual({op:"config.set",params:{key:"planner",value:"codex",integrations:"install"}});
});

test("UI delegation preserves panel completion notification eligibility",async()=>{
 const ctx=await ctxWithStrategy();
 const result=await callOp(ctx,"task.delegate",{goal:"fix",repo:ctx.home,source:"ui"},{spawnRunner:()=>{}}) as {task_id:string};
 expect(readTask(ctx,result.task_id)).toMatchObject({source:"ui",fromPanel:true});
});
