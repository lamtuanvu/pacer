import { expect, test } from "bun:test";
import { readActivity } from "../src/activity/log";
import { CoreError } from "../src/core/errors";
import { send } from "../src/session/send";
import { updateOrcaState } from "../src/exec/orca/state";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo } from "./helpers";
import { fakeRun, ok, raw } from "./fixtures/orca/fake";

const TERM = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";

function setup() {
  const f = fakeRun([
    [["orca", "terminal", "send"], raw(JSON.stringify({ ok: true, result: {} }))],
  ]);
  const ctx = fakeCtx({ run: f.run });
  const task = createTask(ctx, { brief: { goal: "g", repo: gitRepo() }, kind: null, requestedExecutor: "cursor", timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; });
  updateOrcaState(ctx, s => { s.workers.ctx_live = { dispatchId: "ctx_live", taskId: task.id, executor: "cursor", worktree: null, terminal: TERM, startedAt: 1 }; });
  return { f, ctx, task };
}

test("send delivers text into the live orca terminal and records it on the timeline", async () => {
  const { f, ctx, task } = setup();
  const updated = await send(ctx, task.id, "go with plan B");
  expect(f.calls).toContainEqual(["orca", "terminal", "send", "--terminal", TERM, "--text", "go with plan B", "--enter", "--json"]);
  expect(updated.driving).toEqual({ by: "planner", at: ctx.now });
  const { entries } = readActivity(ctx, { taskId: task.id, kinds: ["message"] });
  expect(entries).toHaveLength(1);
  expect(entries[0].text).toContain("go with plan B");
});

test("send refuses a task with no live orca terminal", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: gitRepo() }, kind: null, requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; });
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("this task has no live Orca terminal to send into");
});

test("send refuses a task that is not running or needs_input", async () => {
  const { ctx, task } = setup();
  updateTask(ctx, task.id, t => { t.state = "done"; });
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("task is done, not running");
});

test("send refuses empty or oversized text", async () => {
  const { ctx, task } = setup();
  for (const text of ["", "   ", "x".repeat(4001)]) await expect(send(ctx, task.id, text)).rejects.toThrow();
});

test("executors cannot use pacer send", async () => {
  const { ctx, task } = setup();
  ctx.env = { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: task.id };
  await expect(send(ctx, task.id, "hi")).rejects.toThrow("executors cannot use pacer send");
});

test("a second send within the lease window is refused unless forced", async () => {
  const { ctx, task } = setup();
  await send(ctx, task.id, "first", { by: "operator-a" });
  await expect(send(ctx, task.id, "second", { by: "operator-b" })).rejects.toThrow(/operator-a sent a message \d+s ago; use --force/);
  const forced = await send(ctx, task.id, "second", { by: "operator-b", force: true });
  expect(forced.driving).toEqual({ by: "operator-b", at: ctx.now });
  const { entries } = readActivity(ctx, { taskId: task.id, kinds: ["message"] });
  expect(entries[0]?.text).toContain("took over from operator-a");
});

test("sending again with the same identity never needs --force", async () => {
  const { ctx, task } = setup();
  await send(ctx, task.id, "first", { by: "planner" });
  await expect(send(ctx, task.id, "second", { by: "planner" })).resolves.toBeTruthy();
});

test("unknown task and bad id are reported as CoreError", async () => {
  const ctx = fakeCtx();
  await expect(send(ctx, "t-20261016-000000-abcd", "hi")).rejects.toBeInstanceOf(CoreError);
  await expect(send(ctx, "../escape", "hi")).rejects.toBeInstanceOf(CoreError);
});
