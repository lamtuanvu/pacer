import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { review } from "../src/core/tasks";
import { mergeTaskOnAccept } from "../src/workflow/branch";
import { stepByTask, workflowDatabase } from "../src/workflow/store";

/**
 * Ordinary (non-workflow) accept must not enter the run-branch merge path.
 * Plan Task 8: accept in src/core/tasks.ts review() behaves exactly as before
 * for tasks that are not workflow step tasks.
 */
test("ordinary task accept: mergeTaskOnAccept is a no-op and review has no merge fields", async () => {
  const ctx = fakeCtx({ run: realRun });
  workflowDatabase(ctx);
  const repo = gitRepo();
  const task = createTask(ctx, {
    brief: { goal: "ordinary", repo },
    kind: "feature",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct", worktree: tmpDir() };
    t.worktree = t.result.worktree;
    return t;
  });

  expect(stepByTask(ctx, task.id)).toBeNull();
  expect(await mergeTaskOnAccept(ctx, task.id)).toBeNull();

  const live = readTask(ctx, task.id)!;
  const result = await review(ctx, task.id, { verdict: "accept", expectRev: live.rev });
  expect(result.task.review?.accepted).toBe(true);
  expect(result.merge).toBeUndefined();
  expect(result.resolution_task).toBeUndefined();
  expect(result.accepted).toBeUndefined();

  const branches = await ctx.run(["git", "-C", repo, "branch", "--list", "pacer/run-*"], 10_000);
  expect(branches.stdout.trim()).toBe("");
});
