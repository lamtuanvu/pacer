import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { cmdToOp, runMappedCmd } from "../src/api/cmd";
import { ApiError } from "../src/api/client";
import { CoreError } from "../src/core/errors";
import { consoleCommands, type ConsoleDeps } from "../src/console/console";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

async function ctxWithStrategy() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  return ctx;
}

test("the dashboard and the shared module expose the same mapping", async () => {
  const dash = await import("../src/dashboard/data");
  expect(dash.cmdToOp).toBe(cmdToOp);
});

test("runMappedCmd reports success and errors and skips unmapped commands", async () => {
  const ctx = await ctxWithStrategy();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const call = (op: string, p: unknown) => callOp(ctx, op, p);
  expect(await runMappedCmd(call, { cmd: "stop", taskId: t.id })).toEqual({ handled: true, ok: true, message: `${t.id} stopped` });
  expect(readTask(ctx, t.id)?.state).toBe("stopped");
  expect(await runMappedCmd(call, { cmd: "stop", taskId: "missing" })).toMatchObject({ handled: true, ok: false, message: expect.stringMatching(/^pacer: .*missing/) });
  expect(await runMappedCmd(call, { cmd: "check-updates" })).toEqual({ handled: false });
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
