import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { review } from "../src/core/tasks";
import { createTask, readTask, taskDatabase, updateTask } from "../src/tasks/store";

test("ordinary accept performs no workflow DB write or DDL", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  const task = createTask(ctx, {
    brief: { goal: "plain", repo }, kind: "feature", requestedExecutor: null, timeoutS: 60,
  });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct" };
  });
  const db = taskDatabase(ctx);
  expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_steps'").get()).toBeNull();

  const result = await review(ctx, task.id, { verdict: "accept", expectRev: readTask(ctx, task.id)!.rev });
  expect(result.task.review?.accepted).toBe(true);

  const workflowTables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow_%'",
  ).all().map(r => r.name);
  expect(workflowTables).toEqual([]);
});
