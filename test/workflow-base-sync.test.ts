import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import * as tasks from "../src/core/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import { getRun, insertRun, insertStep, workflowDatabase } from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, runBranchName, syncBase,
} from "../src/workflow/branch";
import type { DelegateInput } from "../src/tasks/api";
import type { TaskRecord } from "../src/tasks/types";

async function seeded() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

async function doneStepTask(ctx: ReturnType<typeof fakeCtx>, repo: string, runId: string, file: string) {
  const task = createTask(ctx, {
    brief: { goal: "impl", repo, base: getRun(ctx, runId)!.branch },
    kind: "feature", requestedExecutor: "codex", timeoutS: 600,
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
    t.run = { mode: "new", workdir: wt.path, startedAt: ctx.now, executor: "codex", attempt: 1 };
    t.result = { status: "done", executor: "codex", model: null, files: file, report: "", backend: "direct", worktree: wt.path };
  });
  return { task: readTask(ctx, task.id)!, branch: wt.branch, worktree: wt.path };
}

test("reject keeps the task branch and leaves the run branch alone", async () => {
  const { ctx, repo, run } = await seeded();
  const { task, branch } = await doneStepTask(ctx, repo, run.id, "r.txt");
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  await tasks.review(ctx, task.id, { verdict: "reject" });
  expect(readTask(ctx, task.id)!.review).toMatchObject({ accepted: false });
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
  const still = await ctx.run(["git", "-C", repo, "rev-parse", "--verify", branch], 10_000);
  expect(still.code).toBe(0);
  const log = (await ctx.run(["git", "-C", repo, "log", "--oneline", run.branch!], 10_000)).stdout;
  expect(log).not.toContain("r.txt");
});

test("retry of a run step starts a new worktree from the current run branch tip", async () => {
  const { ctx, repo, run } = await seeded();
  const { task } = await doneStepTask(ctx, repo, run.id, "old.txt");
  // Advance the run branch tip after the task finished.
  const wt = await integrationWorktree(ctx, run);
  await Bun.write(join(wt, "tip.txt"), "tip");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "tip"], 10_000);
  const tip = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();

  const inputs: DelegateInput[] = [];
  const delegate = async (c: typeof ctx, input: DelegateInput) => {
    inputs.push(input);
    const create = () => createTask(c, {
      brief: input.brief, kind: input.kind ?? null, requestedExecutor: input.executor ?? null, timeoutS: 600,
      ...(input.retryOf ? {} : {}),
    });
    const child = input.commitWith ? input.commitWith(create) : create();
    if (input.retryOf) updateTask(c, child.id, t => { t.retryOf = input.retryOf; });
    return child;
  };
  const result = await tasks.review(ctx, task.id, { verdict: "retry", executor: "cursor" }, { delegate });
  expect(result.retry).toBeTruthy();
  expect(inputs[0]?.brief.base).toBe(run.branch);
  expect(inputs[0]?.reuseWorktree).toBeUndefined();
  expect(inputs[0]?.worktree).toBe("new");
  // The tip the retry would start from is the advanced run branch.
  const resolved = (await ctx.run(["git", "-C", repo, "rev-parse", inputs[0]!.brief.base!], 10_000)).stdout.trim();
  expect(resolved).toBe(tip);
});

test("syncBase merges the base tip into the run branch", async () => {
  const { ctx, repo, run } = await seeded();
  // Advance main (base) ahead of the run branch.
  await Bun.write(join(repo, "base.txt"), "base");
  await ctx.run(["git", "-C", repo, "add", "."], 10_000);
  await ctx.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base advance"], 10_000);
  const baseTip = (await ctx.run(["git", "-C", repo, "rev-parse", "main"], 10_000)).stdout.trim();
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(before).not.toBe(baseTip);

  const result = await syncBase(ctx, run.id, run.rev);
  expect(result).toMatchObject({ ok: true });
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).not.toBe(before);
  const show = await ctx.run(["git", "-C", repo, "show", `${run.branch!}:base.txt`], 10_000);
  expect(show.code).toBe(0);
  expect(show.stdout).toBe("base");
});

test("syncBase conflict returns resolution_task and leaves the run branch", async () => {
  const { ctx, repo, run } = await seeded();
  // Diverging edits on the same file.
  const iwt = await integrationWorktree(ctx, run);
  await Bun.write(join(iwt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", iwt, "add", "."], 10_000);
  await ctx.run(["git", "-C", iwt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run clash"], 10_000);
  await Bun.write(join(repo, "clash.txt"), "from-base\n");
  await ctx.run(["git", "-C", repo, "add", "."], 10_000);
  await ctx.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base clash"], 10_000);
  const before = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();

  const result = await syncBase(ctx, run.id, getRun(ctx, run.id)!.rev);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected conflict");
  expect(result.merge).toBe("conflict");
  expect(result.resolution_task).toMatch(/^t-/);
  const after = (await ctx.run(["git", "-C", repo, "rev-parse", run.branch!], 10_000)).stdout.trim();
  expect(after).toBe(before);
});
