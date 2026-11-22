import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, isCodeStep } from "../src/workflow/branch";

test("isCodeStep treats docs and unfamiliar-code as code by default", () => {
  expect(isCodeStep({ kind: "docs" })).toBe(true);
  expect(isCodeStep({ kind: "unfamiliar-code" })).toBe(true);
  expect(isCodeStep({ kind: "research" })).toBe(false);
  expect(isCodeStep({ kind: "docs", code: false })).toBe(false);
});

test("accepting a research step in a branched run without a task branch succeeds", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  // A prior code step created the run branch; this research step has no pacer/<id>.
  await ensureRunBranch(ctx, run);
  expect(getRun(ctx, run.id)?.branch).toBeTruthy();

  const task = createTask(ctx, {
    brief: { goal: "notes", repo }, kind: "research", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "notes", attempt: 1, taskId: task.id, status: "done" });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "ok", backend: "direct" };
  });

  const before = (await ctx.run(["git", "-C", repo, "rev-parse", getRun(ctx, run.id)!.branch!], 10_000)).stdout.trim();
  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
  expect(result.merge).toBeUndefined();
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", getRun(ctx, run.id)!.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
  expect(readTask(ctx, task.id)!.review?.accepted).toBe(true);
});

test("accepting a current-placement step with no pacer branch takes the plain accept path", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);

  const task = createTask(ctx, {
    brief: { goal: "inplace", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "inplace", attempt: 1, taskId: task.id, status: "done" });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.placement = { requested: "current", mode: "current", why: "agent: current" };
    t.worktree = repo;
    t.result = {
      status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct", worktree: repo,
    };
  });

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
});
