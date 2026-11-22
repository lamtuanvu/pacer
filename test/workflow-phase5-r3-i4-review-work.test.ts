import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import * as tasks from "../src/core/tasks";
import { reviewWork } from "../src/core/work";
import { callOp } from "../src/api/ops";
import { registerWork } from "../src/dispatch/work";
import { workEvents } from "../src/dispatch/work";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree,
} from "../src/workflow/branch";

async function seededConflictWork() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "work_node" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;

  // Root work node (parent must be running to register children with allowDelegation).
  const root = createTask(ctx, {
    brief: { goal: "root", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  updateTask(ctx, root.id, t => { t.state = "running"; });
  registerWork(ctx, root.id, {
    allowDelegation: true, maxDepth: 5, maxDescendants: 20, maxConcurrent: 4,
    delegationEnforcement: "strict",
  });

  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  registerWork(ctx, task.id, {
    allowDelegation: false, delegationEnforcement: "strict",
  }, root.id);
  insertStep(ctx, { runId: live.id, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });

  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const wt = await createTaskWorktree(ctx, info, task.id, live.branch!);
  if ("error" in wt) throw new Error(wt.error);
  const baseSha = (await ctx.run(["git", "-C", wt.path, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  await Bun.write(join(wt.path, "clash.txt"), "from-task\n");
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "task"], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.baseSha = baseSha;
    t.run = { mode: "new", workdir: wt.path, dir: wt.path, logFile: join(wt.path, "log"), startedAt: ctx.now, executor: "codex", attempt: 1 };
    t.result = { status: "done", executor: "codex", model: null, files: "clash.txt", report: "", backend: "direct", worktree: wt.path };
  });

  // Diverge the run branch so accept conflicts.
  const iwt = await integrationWorktree(ctx, live);
  await Bun.write(join(iwt, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", iwt, "add", "."], 10_000);
  await ctx.run(["git", "-C", iwt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run"], 10_000);

  return { ctx, task: readTask(ctx, task.id)!, run: getRun(ctx, live.id)! };
}

test("R3-I4: reviewWork on merge conflict does not emit work.reviewed or accept", async () => {
  const { ctx, task } = await seededConflictWork();
  const before = workEvents(ctx, task.id, 0).length;

  const result = await reviewWork(ctx, task.id, true, undefined, task.rev);
  expect(result.accepted).toBe(false);
  expect(result.merge).toBe("conflict");
  expect(result.resolution_task).toBeTruthy();
  expect(readTask(ctx, task.id)!.review).toBeUndefined();

  const events = workEvents(ctx, task.id, 0);
  expect(events.some(e => e.kind === "work.reviewed")).toBe(false);
  expect(events.length).toBe(before);
});

test("R3-I4: task.review op path skips recheckAfterAccept on conflict", async () => {
  const { ctx, task } = await seededConflictWork();
  const result = await callOp(ctx, "task.review", {
    id: task.id, verdict: "accept", expect_rev: task.rev,
  }) as { accepted?: boolean; merge?: string; resolution_task?: string };
  expect(result.accepted).toBe(false);
  expect(result.merge).toBe("conflict");
  expect(readTask(ctx, task.id)!.review).toBeUndefined();
  // No false acceptance via the plain tasks.review path either.
  const again = await tasks.review(ctx, task.id, { verdict: "accept" });
  // Still conflict (or already has resolution); never records accept without merge.
  expect(readTask(ctx, task.id)!.review?.accepted).not.toBe(true);
  void again;
});
