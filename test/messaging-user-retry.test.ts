import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { main, cliDeps } from "../src/cli";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { taskDetail } from "../src/core/task-detail";
import type { Ctx } from "../src/types";

const failedAttempt = (ctx: Ctx) => ({ executor: "codex", model: null, startedAt: ctx.now - 2, endedAt: ctx.now - 1, exitCode: 1, timedOut: false, limitHit: false, log: "" });
function workRoot(ctx: Ctx, origin: string, parent?: string) {
  const task = createTask(ctx, { brief: { goal: "root", repo: parent ? readTask(ctx, parent)!.brief.repo : tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  // A child registers while its parent runs.
  const running = parent ? readTask(ctx, parent)!.state : undefined;
  if (parent) updateTask(ctx, parent, t => { t.state = "running"; });
  registerWork(ctx, task.id, { allowDelegation: true, delegationEnforcement: "strict" }, parent);
  if (parent) updateTask(ctx, parent, t => { t.state = running!; });
  return updateTask(ctx, task.id, t => { if (!parent) t.origin = origin; t.state = "failed"; t.attempts.push(failedAttempt(ctx)); });
}
const deps = { spawnRunner: () => 1 };
type Retried = { retry: { task_id: string; state: string }; of: { task_id: string } };

test("task.retry on a work root a person started restarts it in place, once per revision", async () => {
  const ctx = fakeCtx();
  const t = workRoot(ctx, "human");
  const r = await callOp(ctx, "task.retry", { id: t.id, expect_rev: t.rev }, deps) as Retried;
  expect(r.retry).toMatchObject({ task_id: t.id, state: "queued" });
  expect(r.of.task_id).toBe(t.id);
  expect(readTask(ctx, t.id)!.state).toBe("queued");
  // The same click again replays the stable request id instead of a second attempt.
  const replay = await callOp(ctx, "task.retry", { id: t.id, expect_rev: t.rev }, deps) as Retried;
  expect(replay.retry.task_id).toBe(t.id);
  expect(readTask(ctx, t.id)!.state).toBe("queued");
});

test("task.retry on a user-started root refuses a stale revision and an executor override", async () => {
  const ctx = fakeCtx();
  const t = workRoot(ctx, "human");
  await expect(callOp(ctx, "task.retry", { id: t.id, expect_rev: t.rev + 1 }, deps)).rejects.toThrow(/revision/i);
  await expect(callOp(ctx, "task.retry", { id: t.id, expect_rev: t.rev, executor: "claude" }, deps)).rejects.toThrow(/Executor overrides/);
});

test("task.retry still refuses planner roots and work children", async () => {
  const ctx = fakeCtx();
  const planner = workRoot(ctx, "external:planner");
  await expect(callOp(ctx, "task.retry", { id: planner.id, expect_rev: planner.rev }, deps)).rejects.toThrow("Use dispatch.retry");
  const human = workRoot(ctx, "human"), child = workRoot(ctx, "human", human.id);
  await expect(callOp(ctx, "task.retry", { id: child.id, expect_rev: child.rev }, deps)).rejects.toThrow("Use dispatch.retry");
});

test("task.retry_all restarts user-started roots and skips other managed work with a reason", async () => {
  const ctx = fakeCtx();
  const human = workRoot(ctx, "human"), planner = workRoot(ctx, "external:planner");
  const r = await callOp(ctx, "task.retry_all", { ids: [human.id, planner.id] }, deps) as { retried: Retried[]; skipped: { id: string; reason: string }[] };
  expect(r.retried.map(x => x.retry.task_id)).toEqual([human.id]);
  expect(r.skipped).toEqual([{ id: planner.id, reason: expect.stringContaining("dispatch.submit") }]);
});

test("pacer retry on a user-started root takes the managed retry", async () => {
  const ctx = fakeCtx(), spawn = cliDeps.spawnRunner;
  const t = workRoot(ctx, "human");
  cliDeps.spawnRunner = () => 1;
  try {
    const r = await main(["retry", t.id], ctx);
    expect(r).toMatchObject({ code: 0, out: `${t.id} queued (managed retry)` });
    expect(readTask(ctx, t.id)!.state).toBe("queued");
  } finally { cliDeps.spawnRunner = spawn; }
});

test("task detail marks only user-started roots", async () => {
  const ctx = fakeCtx();
  const human = workRoot(ctx, "human"), planner = workRoot(ctx, "external:planner"), child = workRoot(ctx, "human", human.id);
  expect((await taskDetail(ctx, human.id)).work?.userStarted).toBe(true);
  expect((await taskDetail(ctx, planner.id)).work?.userStarted).toBeUndefined();
  expect((await taskDetail(ctx, child.id)).work?.userStarted).toBeUndefined();
});
