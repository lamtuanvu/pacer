import { expect, test } from "bun:test";
import { main } from "../src/cli";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";

const TERM = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";

function setup() {
  const f = fakeRun([
    [["orca", "orchestration", "worker-show"], raw(JSON.stringify({ ok: true, result: { worker: { state: "running" } } }))],
    [["orca", "terminal", "show"], raw(JSON.stringify({ ok: true, result: { terminal: { handle: TERM, connected: true, writable: true, agentIdentity: "codex" } } }))],
    [["orca", "terminal", "send"], raw(JSON.stringify({ ok: true, result: {} }))],
  ]);
  const ctx = fakeCtx({ run: f.run });
  ctx.env = { ...ctx.env, USER: "alice", ORCA_TERMINAL_HANDLE: "term_planner" };
  const task = createTask(ctx, { brief: { goal: "g", repo: gitRepo() }, kind: null, requestedExecutor: "codex", timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.live = { backend: "orca", worker: "ctx_live", terminal: TERM, executor: "codex", agent: "codex", since: 1 }; });
  return { f, ctx, task };
}

test("pacer send delivers a message and exits 0", async () => {
  const { f, ctx, task } = setup();
  const result = await main(["send", task.id, "go with plan B"], ctx);
  expect(result).toMatchObject({ code: 0, out: `sent to ${task.id}` });
  expect(f.calls).toContainEqual(["orca", "terminal", "send", "--terminal", TERM, "--text", "go with plan B", "--enter", "--json"]);
  expect(readTask(ctx, task.id)?.driving?.by).toBe("alice@term_planner");
});

test("pacer send --json prints the updated task", async () => {
  const { ctx, task } = setup();
  const result = await main(["send", task.id, "hi", "--json"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).id).toBe(task.id);
});

test("pacer send requires exactly a task id and a message", async () => {
  const { ctx, task } = setup();
  expect((await main(["send", task.id], ctx)).code).toBe(2);
  expect((await main(["send"], ctx)).code).toBe(2);
});

test("pacer send refuses contention without --force and succeeds with it", async () => {
  const { ctx, task } = setup();
  updateTask(ctx, task.id, t => { t.driving = { by: "operator-a", at: ctx.now }; });
  const refused = await main(["send", task.id, "second"], ctx);
  expect(refused.code).toBe(2);
  expect(refused.err).toContain("use --force");
  const forced = await main(["send", task.id, "second", "--force"], ctx);
  expect(forced.code).toBe(0);
});
