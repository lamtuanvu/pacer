import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  getRun, insertRun, insertStep, setPublishOptIn, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, mergeTaskOnAccept,
} from "../src/workflow/branch";
import { hasUnresolvedConflictTask, publishRun } from "../src/workflow/publish";

async function seededRun() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

async function stepTaskWithCommit(
  ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string, body: string,
) {
  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const run = getRun(ctx, runId)!;
  const wt = await createTaskWorktree(ctx, info, task.id, run.branch!);
  if ("error" in wt) throw new Error(wt.error);
  await Bun.write(join(wt.path, file), body);
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `add ${file}`], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.run = { mode: "new", workdir: wt.path, dir: wt.path, logFile: join(wt.path, "log"), startedAt: ctx.now, executor: "codex", attempt: 1 };
    t.result = { status: "done", executor: "codex", model: null, files: file, report: "", backend: "direct", worktree: wt.path };
  });
  return { task: readTask(ctx, task.id)!, worktree: wt.path, branch: wt.branch };
}

test("conflict sets a durable run marker; publish reads the marker not task state", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "clash.txt", "from-task\n");
  const wt = await integrationWorktree(ctx, run);
  await Bun.write(join(wt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run clash"], 10_000);

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.merge).toBe("conflict");
  const live = getRun(ctx, run.id)!;
  expect(live.conflict).toEqual([{
    taskId: task.id,
    branch: `pacer/${task.id}`,
    resolutionTaskId: result.resolution_task,
  }]);
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(true);

  // Even if the resolution task is marked failed (old 600s sweep), the marker still blocks.
  updateTask(ctx, result.resolution_task!, t => {
    t.state = "failed";
    t.result = { status: "failed", executor: null, model: null, files: "", report: "never started", backend: "direct" };
  });
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(true);

  setPublishOptIn(ctx, run.id, "draft");
  await expect(publishRun(ctx, run.id, {
    draft: true, title: "t", body: "b", expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed", message: expect.stringMatching(/conflict/i) });
});

test("accepting the resolution task merges its branch and clears the marker", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "clash.txt", "from-task\n");
  const wt = await integrationWorktree(ctx, run);
  await Bun.write(join(wt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run clash"], 10_000);

  const conflicted = await tasks.review(ctx, task.id, { verdict: "accept" });
  const resId = conflicted.resolution_task!;
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  // Resolution must bring the conflicting branch in (ancestor check) then fix the file.
  const resWt = await createTaskWorktree(ctx, info, resId, run.branch!);
  if ("error" in resWt) throw new Error(resWt.error);
  expect((await ctx.run(["git", "-C", resWt.path, "merge", "--no-edit", `pacer/${task.id}`], 30_000)).code).not.toBe(0);
  await Bun.write(join(resWt.path, "clash.txt"), "resolved\n");
  await ctx.run(["git", "-C", resWt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", resWt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "resolve"], 10_000);
  updateTask(ctx, resId, t => {
    t.state = "done";
    t.worktree = resWt.path;
    t.result = { status: "done", executor: "codex", model: null, files: "clash.txt", report: "fixed", backend: "direct", worktree: resWt.path };
  });

  const accepted = await tasks.review(ctx, resId, { verdict: "accept" });
  expect(accepted.task.review?.accepted).toBe(true);
  expect(getRun(ctx, run.id)!.conflict).toBeUndefined();
  expect(hasUnresolvedConflictTask(ctx, run.id)).toBe(false);

  const show = await ctx.run(["git", "-C", repo, "show", `${run.branch!}:clash.txt`], 10_000);
  expect(show.stdout).toBe("resolved\n");
});

test("conflict resolution task brief fences and caps the file list; requestId dedupes", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "clash.txt", "from-task\n");
  const wt = await integrationWorktree(ctx, run);
  await Bun.write(join(wt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run clash"], 10_000);

  const first = await mergeTaskOnAccept(ctx, task.id);
  expect(first?.merged).toBe(false);
  if (!first || first.merged) throw new Error("expected conflict");
  const res = readTask(ctx, first.resolution_task)!;
  expect(res.brief.goal).toMatch(/--- data /);
  expect(res.brief.goal).toMatch(/manual conflict resolution/i);
  expect(res.state).toBe("needs_input");

  const second = await mergeTaskOnAccept(ctx, task.id);
  expect(second?.merged).toBe(false);
  if (!second || second.merged) throw new Error("expected conflict");
  expect(second.resolution_task).toBe(first.resolution_task);
});
