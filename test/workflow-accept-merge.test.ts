import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { CoreError } from "../src/core/errors";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { autoCleanTask } from "../src/tasks/cleanup";
import { createTaskWorktree, taskWorktreePath } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  addDefinition, getRun, insertRun, insertStep, setRunBranch, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, runBranchName,
} from "../src/workflow/branch";
import type { WorkflowDef } from "../src/workflow/schema";

async function seededRun() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

/** A done step task with its own branch and one commit on top of the run branch. */
async function stepTaskWithCommit(ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string, body: string) {
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

test("accepting a run task merges its branch then records the accept", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "a.txt", "a");
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review).toMatchObject({ accepted: true });
  expect(result.merge).toBeUndefined();
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).not.toBe(before);
  const log = (await ctx.run(["git", "-C", repo, "log", "--oneline", run.branch!], 10_000)).stdout;
  expect(log).toContain("add a.txt");
});

test("cleanup after accept removes the worktree; run branch keeps the commits", async () => {
  const { ctx, repo, run } = await seededRun();
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nexecution:\n  auto_clean: true\n");
  const { task, worktree } = await stepTaskWithCommit(ctx, repo, run.id, "kept.txt", "kept");
  await tasks.review(ctx, task.id, { verdict: "accept" });
  await autoCleanTask(ctx, task.id);
  expect(existsSync(worktree)).toBe(false);
  const show = await ctx.run(["git", "-C", repo, "show", `${run.branch!}:kept.txt`], 10_000);
  expect(show.code).toBe(0);
  expect(show.stdout).toBe("kept");
});

test("merge conflict leaves the run branch untouched and returns resolution_task", async () => {
  const { ctx, repo, run } = await seededRun();
  // Task commits clash.txt first from the shared tip; then the run branch diverges on the same file.
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "clash.txt", "from-task\n");
  const wt = await integrationWorktree(ctx, run);
  await Bun.write(join(wt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run clash"], 10_000);
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();

  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.accepted).toBe(false);
  expect(result.merge).toBe("conflict");
  expect(result.resolution_task).toMatch(/^t-/);
  expect(readTask(ctx, task.id)!.review).toBeUndefined();
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
  expect(readTask(ctx, result.resolution_task!)!.brief.goal).toMatch(/conflict/i);
});

test("dirty task worktree is refused with invalid_input", async () => {
  const { ctx, repo, run } = await seededRun();
  const { task, worktree } = await stepTaskWithCommit(ctx, repo, run.id, "d.txt", "d");
  await Bun.write(join(worktree, "dirty.txt"), "uncommitted");
  await expect(tasks.review(ctx, task.id, { verdict: "accept" })).rejects.toMatchObject({
    code: "invalid_input",
    message: expect.stringMatching(/uncommitted changes in the task worktree/i),
  } as Partial<CoreError>);
  expect(readTask(ctx, task.id)!.review).toBeUndefined();
});

test("ordinary task accept never touches the run-branch helpers", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  // A run exists with a branch, but this task has no step row.
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/x", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const task = createTask(ctx, {
    brief: { goal: "plain", repo }, kind: "feature", requestedExecutor: null, timeoutS: 60,
  });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "", backend: "direct" };
  });
  const tipBefore = (await ctx.run(["git", "-C", repo, "rev-parse", runBranchName(run.id)], 10_000)).stdout.trim();
  const result = await tasks.review(ctx, task.id, { verdict: "accept" });
  expect(result.task.review).toMatchObject({ accepted: true });
  expect(result.merge).toBeUndefined();
  const tipAfter = (await ctx.run(["git", "-C", repo, "rev-parse", runBranchName(run.id)], 10_000)).stdout.trim();
  expect(tipAfter).toBe(tipBefore);
});

test("merge --signoff when .pacer/workflow.json sets merge_signoff", async () => {
  const { ctx, repo, run } = await seededRun();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(repo, ".pacer"), { recursive: true });
  await Bun.write(join(repo, ".pacer", "workflow.json"), JSON.stringify({ merge_signoff: true }));
  const { task } = await stepTaskWithCommit(ctx, repo, run.id, "s.txt", "s");
  await tasks.review(ctx, task.id, { verdict: "accept" });
  const body = (await ctx.run(["git", "-C", repo, "log", "-1", "--format=%B", run.branch!], 10_000)).stdout;
  expect(body).toMatch(/Signed-off-by:/);
});
