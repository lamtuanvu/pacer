import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { taskReviewProbe } from "../src/api/task-review-bridge";
import { createTask, taskDatabase, updateTask } from "../src/tasks/store";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch } from "../src/workflow/branch";

test("taskReviewProbe forwards accept for a step task whose run has a branch", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  expect(getRun(ctx, run.id)?.branch).toMatch(/^pacer\/run-/);

  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });
  updateTask(ctx, task.id, t => { t.state = "done"; });

  expect(taskReviewProbe(ctx, task.id, { verdict: "accept" })).toEqual({
    forward: true,
    reason: "run branch",
  });
  // Reject goes the same way: it takes the review lock an accept's merge holds.
  expect(taskReviewProbe(ctx, task.id, { verdict: "reject" })).toEqual({ forward: true, reason: "run branch" });
});

test("taskReviewProbe accept stays native for an ordinary task without creating workflow tables", () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {
    brief: { goal: "plain", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60,
  });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  const db = taskDatabase(ctx);
  expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_steps'").get()).toBeNull();

  expect(taskReviewProbe(ctx, task.id, { verdict: "accept" })).toEqual({ forward: false });

  expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_steps'").get()).toBeNull();
});
