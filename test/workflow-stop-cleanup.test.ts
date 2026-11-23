import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import { getRun, insertRun, insertStep, workflowDatabase } from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, integrationWorktreePath, runBranchName,
} from "../src/workflow/branch";
import { cleanupRun } from "../src/workflow/cleanup";
import { awaitTerminalSettle, stopRun } from "../src/workflow/engine";

async function repoWithBareOrigin() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  return { ctx, repo, bare };
}

async function seeded() {
  const { ctx, repo, bare } = await repoWithBareOrigin();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, bare, run: getRun(ctx, run.id)! };
}

async function acceptOneCommit(ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string) {
  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const run = getRun(ctx, runId)!;
  const wt = await createTaskWorktree(ctx, info, task.id, run.branch!);
  if ("error" in wt) throw new Error(wt.error);
  await Bun.write(join(wt.path, file), file);
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", file], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.run = { mode: "new", workdir: wt.path, dir: wt.path, logFile: join(wt.path, "log"), startedAt: ctx.now, executor: "codex", attempt: 1 };
    t.result = { status: "done", executor: "codex", model: null, files: file, report: "", backend: "direct", worktree: wt.path };
  });
  await tasks.review(ctx, task.id, { verdict: "accept" });
  return { task: readTask(ctx, task.id)!, taskBranch: wt.branch };
}

test("stop with merged commits leaves the run branch sha unchanged and reports ahead", async () => {
  const { ctx, repo, run } = await seeded();
  await acceptOneCommit(ctx, repo, run.id, "kept.txt");
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  const live = getRun(ctx, run.id)!;
  const stopped = await stopRun(ctx, live.id, live.rev);
  await awaitTerminalSettle(live.id);
  expect(stopped.status).toBe("stopped");
  expect(stopped.branch).toBe(run.branch);
  expect(stopped.ahead).toBeGreaterThanOrEqual(1);
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
  // Integration worktree is removed on terminal settle.
  const top = (await gitInfo(ctx.run, repo));
  if ("error" in top) throw new Error(top.error);
  expect(existsSync(integrationWorktreePath(ctx, top.top, run.id))).toBe(false);
});

test("terminal cleanup deletes only merged task branches", async () => {
  const { ctx, repo, run } = await seeded();
  const { taskBranch: merged } = await acceptOneCommit(ctx, repo, run.id, "m.txt");
  // An unmerged task branch (reject path): create another task branch without merging.
  const task = createTask(ctx, {
    brief: { goal: "other", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "other", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const wt = await createTaskWorktree(ctx, info, task.id, getRun(ctx, run.id)!.branch!);
  if ("error" in wt) throw new Error(wt.error);
  await Bun.write(join(wt.path, "unmerged.txt"), "u");
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "unmerged"], 10_000);
  updateTask(ctx, task.id, t => { t.state = "done"; t.worktree = wt.path; });
  await tasks.review(ctx, task.id, { verdict: "reject" });

  const live = getRun(ctx, run.id)!;
  await stopRun(ctx, live.id, live.rev);
  await awaitTerminalSettle(live.id);

  const mergedGone = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", merged], 10_000);
  expect(mergedGone.code).not.toBe(0);
  const unmergedKept = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", wt.branch], 10_000);
  expect(unmergedKept.code).toBe(0);
  // Run branch still present with the merged commit.
  const show = await ctx.run(["git", "-C", repo, "show", `${run.branch!}:m.txt`], 10_000);
  expect(show.code).toBe(0);
});

test("cleanupRun deletes the local run branch and not the bare remote's", async () => {
  const { ctx, repo, bare, run } = await seeded();
  await acceptOneCommit(ctx, repo, run.id, "pub.txt");
  // Push the run branch to the bare remote so we can prove cleanup never touches it.
  const wt = await integrationWorktree(ctx, getRun(ctx, run.id)!);
  expect((await ctx.run(["git", "-C", wt, "push", "origin", run.branch!], 60_000)).code).toBe(0);
  const remoteBefore = (await ctx.run(["git", "--git-dir", bare, "rev-parse", run.branch!], 10_000)).stdout.trim();

  const live = getRun(ctx, run.id)!;
  await stopRun(ctx, live.id, live.rev);
  await awaitTerminalSettle(live.id);
  const afterStop = getRun(ctx, run.id)!;
  const cleaned = await cleanupRun(ctx, afterStop.id, { deleteBranch: true, expectRev: afterStop.rev });
  expect(cleaned.deleted_branch).toBe(run.branch!);

  const local = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", run.branch!], 10_000);
  expect(local.code).not.toBe(0);
  const remoteAfter = (await ctx.run(["git", "--git-dir", bare, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(remoteAfter).toBe(remoteBefore);
});

test("cleanupRun without delete_branch keeps the run branch", async () => {
  const { ctx, repo, run } = await seeded();
  await acceptOneCommit(ctx, repo, run.id, "keep.txt");
  const live = getRun(ctx, run.id)!;
  await stopRun(ctx, live.id, live.rev);
  await awaitTerminalSettle(live.id);
  const after = getRun(ctx, run.id)!;
  const result = await cleanupRun(ctx, after.id, { deleteBranch: false, expectRev: after.rev });
  expect(result.deleted_branch).toBeNull();
  const still = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", run.branch!], 10_000);
  expect(still.code).toBe(0);
});

test("cleanupRun under PACER_RUN_GRANT is not_allowed", async () => {
  const { ctx, run } = await seeded();
  ctx.env = { ...ctx.env, PACER_RUN_GRANT: "prg_test" };
  await expect(cleanupRun(ctx, run.id, {
    deleteBranch: true, expectRev: getRun(ctx, run.id)!.rev,
  })).rejects.toMatchObject({ code: "not_allowed" });
});

test("runBranchName stays stable for cleanup naming", () => {
  expect(runBranchName("run_abcdefghij")).toBe("pacer/run-abcdefghij");
});
