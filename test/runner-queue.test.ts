import { expect, test } from "bun:test";
import { runTask } from "../src/tasks/runner";
import { readTask, updateTask } from "../src/tasks/store";
import { taskStatus } from "../src/tasks/api";
import { fakeCtx } from "./helpers";

import { queueStrategy, queueTask, queueDeps } from "./queue-helpers";

for (const second of [false, true]) test(`full executor ${second ? "falls through" : "queues without an attempt"}`, async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b");
  updateTask(ctx, a.id, t => {t.state = "running"; t.executor = "codex"; t.runnerPid = process.pid;});
  const result = await runTask(ctx, b.id, queueDeps(queueStrategy(second)));
  if (second) expect(result.result?.executor).toBe("cursor");
  else {expect(result.state).toBe("queued"); expect(result.queue).toMatchObject({reason: "no_slot", position: 1, limit: "executor", capacity: {used: 1, max: 1}}); expect(result.attempts).toEqual([]);}
});
test("a full pinned executor queues even with a free fallback", async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b", "codex");
  updateTask(ctx, a.id, t => {t.state = "running"; t.executor = "codex";});
  expect((await runTask(ctx, b.id, queueDeps(queueStrategy(true)))).queue?.reason).toBe("no_slot");
});
test("concurrent runners reserve one slot atomically", async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b"), deps = queueDeps();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => {release = r;}), started = new Promise<void>(r => {entered = r;});
  deps.runAttempt = async (...args) => {entered(); await gate; return queueDeps().runAttempt!(...args);};
  const first = runTask(ctx, a.id, deps), second = runTask(ctx, b.id, deps); await started;
  const queued = await Promise.race([first, second]);
  expect([readTask(ctx, a.id)?.state, readTask(ctx, b.id)?.state].sort()).toEqual(["queued", "running"]);
  expect(queued.queue?.reason).toBe("no_slot");
  release(); await Promise.all([first, second]);
});
test("waiting tasks survive the never-started timeout", () => {
  const ctx = fakeCtx(), t = queueTask(ctx);
  updateTask(ctx, t.id, x => {x.queue = {reason: "no_slot", since: ctx.now, position: 1};});
  expect(taskStatus({...ctx, now: ctx.now + 700}, t.id)?.state).toBe("queued");
});
test("a runner that starts during a pause queues without attempting", async () => {
  const {pause} = await import("../src/core/pause");
  const ctx = fakeCtx(), task = queueTask(ctx);
  pause(ctx, {for: "1h"});
  expect(await runTask(ctx, task.id, queueDeps())).toMatchObject({state: "queued", queue: {reason: "paused"}, attempts: []});
});
test("machine capacity queues a different executor", async () => {
  const ctx = fakeCtx(), active = queueTask(ctx, "active"), task = queueTask(ctx, "waiting", "cursor");
  updateTask(ctx, active.id, t => {t.state = "running"; t.executor = "codex";});
  const s = queueStrategy(true); s.execution.local_max_tasks = 1;
  expect((await runTask(ctx, task.id, queueDeps(s))).queue).toMatchObject({reason: "no_slot", limit: "machine", capacity: {used: 1, max: 1}});
});
