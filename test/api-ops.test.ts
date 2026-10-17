import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callOp, opNames } from "../src/api/ops";
import { httpStatus, toApiError } from "../src/api/protocol";
import { createTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

async function ctxWithStrategy() {
  const ctx = fakeCtx();
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
  expect((await callOp(ctx, "task.list", {})) as unknown[]).toHaveLength(1);
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
 updateTask(ctx,t.id,t=>{t.state="done";});
 const id=`review:${t.id}`;
 expect(await Promise.all([callOp(ctx,"attention.dismiss",{id}),callOp(ctx,"attention.dismiss",{id})])).toEqual([{dismissed:true},{dismissed:true}]);
 expect(readTask(ctx,t.id)?.dismissed).toBe(true);
 expect(await codeOf(callOp(ctx,"attention.dismiss",{id:"review:missing"}))).toBe("unknown_task");
});
test("attention snooze validates duration and returns its expiry",async()=>{
 const {updateTask}=await import("../src/tasks/store");
 const ctx=await ctxWithStrategy(),t=createTask(ctx,{brief:{goal:"review me",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,t=>{t.state="done";});
 expect(await callOp(ctx,"attention.snooze",{id:`review:${t.id}`,for:"1h"})).toEqual({until:ctx.now+3600});
 expect(await codeOf(callOp(ctx,"attention.snooze",{id:`review:${t.id}`,for:"2h"}))).toBe("invalid_input");
});

test("setup attention can be dismissed before a strategy is configured",async()=>{
 const ctx=fakeCtx();
 const {liveSnapshot}=await import("../src/api/events");
 const status=async()=>{throw new Error("not configured");};
 const before=await liveSnapshot(ctx,{status});
 const item=before.snapshot.attention.find(i=>i.kind==="setup")!;
 expect(item).toBeDefined();
 expect(await callOp(ctx,"attention.dismiss",{id:item.id})).toEqual({dismissed:true});
 expect((await liveSnapshot(ctx,{status})).snapshot.attention.some(i=>i.id===item.id)).toBe(false);
});
