import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import * as tasks from "../src/core/tasks";
import { gitInfo } from "../src/core/git";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, integrationWorktreePath,
} from "../src/workflow/branch";
import { awaitTerminalSettle, stopRun } from "../src/workflow/engine";

async function seeded() {
  const repo = gitRepo();
  const bare = join(tmpDir(), "origin.git");
  const ctx = fakeCtx({ run: realRun });
  expect((await ctx.run(["git", "clone", "--bare", "-q", repo, bare], 30_000)).code).toBe(0);
  expect((await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000)).code).toBe(0);
  workflowDatabase(ctx);
  const run = insertRun(ctx, {
    workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain",
    planner: "claude-code",
  });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

async function doneTaskOnRun(ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string) {
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
  return { task: readTask(ctx, task.id)!, taskBranch: wt.branch };
}

test("accept after run stop leaves no integration worktree and no wakeup/conflict", async () => {
  const { ctx, repo, run } = await seeded();
  // Create the integration worktree then stop so terminal settle removes it.
  await integrationWorktree(ctx, run);
  const { task } = await doneTaskOnRun(ctx, repo, run.id, "post.txt");
  const live = getRun(ctx, run.id)!;
  await stopRun(ctx, live.id, live.rev);
  await awaitTerminalSettle(live.id);

  const top = await gitInfo(ctx.run, repo);
  if ("error" in top) throw new Error(top.error);
  expect(existsSync(integrationWorktreePath(ctx, top.top, run.id))).toBe(false);

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
  expect(result.merge).toBeUndefined();
  expect(existsSync(integrationWorktreePath(ctx, top.top, run.id))).toBe(false);
  expect(getRun(ctx, run.id)!.conflict ?? []).toEqual([]);

  const openWakeups = workflowDatabase(ctx).query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM workflow_wakeups WHERE run_id = ? AND done_at IS NULL",
  ).get(run.id);
  expect(openWakeups?.n ?? 0).toBe(0);
});

test("accept after run done leaves no integration worktree", async () => {
  const { ctx, repo, run } = await seeded();
  const { task } = await doneTaskOnRun(ctx, repo, run.id, "done.txt");
  const live = getRun(ctx, run.id)!;
  // Mark done via updateRun + schedule settle through stop-equivalent path:
  // use stopRun for settle, then flip is already terminal — use done via cleanup path.
  const { updateRun } = await import("../src/workflow/store");
  const { settleRunGitAfterTerminal } = await import("../src/workflow/engine");
  const done = updateRun(ctx, live.id, live.rev, { status: "done" });
  await settleRunGitAfterTerminal(ctx, done);

  const top = await gitInfo(ctx.run, repo);
  if ("error" in top) throw new Error(top.error);
  expect(existsSync(integrationWorktreePath(ctx, top.top, run.id))).toBe(false);

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review?.accepted).toBe(true);
  expect(existsSync(integrationWorktreePath(ctx, top.top, run.id))).toBe(false);
  expect(getRun(ctx, run.id)!.conflict ?? []).toEqual([]);
});
