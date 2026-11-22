import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { createTaskWorktree } from "../src/supervisor/worktree";
import { gitInfo } from "../src/core/git";
import {
  getRun, insertRun, insertStep, workflowDatabase,
} from "../src/workflow/store";
import { ensureRunBranch, integrationWorktree, syncBase } from "../src/workflow/branch";
import { runCmd } from "../src/commands/run";
import { callOp, type OpDeps } from "../src/api/ops";
import { main } from "../src/cli";

test("pacer review --accept returns non-zero on merge conflict via real CLI entry", async () => {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const task = createTask(ctx, {
    brief: { goal: "impl", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600,
  });
  insertStep(ctx, { runId: run.id, stepId: "impl", attempt: 1, taskId: task.id, status: "done" });
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new Error(info.error);
  const live = getRun(ctx, run.id)!;
  const wt = await createTaskWorktree(ctx, info, task.id, live.branch!);
  if ("error" in wt) throw new Error(wt.error);
  await Bun.write(join(wt.path, "clash.txt"), "from-task\n");
  await ctx.run(["git", "-C", wt.path, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "task"], 10_000);
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.worktree = wt.path;
    t.result = { status: "done", executor: "codex", model: null, files: "clash.txt", report: "", backend: "direct", worktree: wt.path };
  });
  const integ = await integrationWorktree(ctx, live);
  await Bun.write(join(integ, "clash.txt"), "from-run\n");
  await ctx.run(["git", "-C", integ, "add", "."], 10_000);
  await ctx.run(["git", "-C", integ, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run"], 10_000);

  const plain = await main(["review", task.id, "--accept"], ctx);
  expect(plain.code).toBe(1);
  expect(plain.out).toMatch(/merge conflict/);
  expect(plain.out).toMatch(/t-/);

  // Re-create conflict state is already set; --json shape for the same accept path.
  // Second accept of the same conflicted task returns the (deduped) resolution again.
  const json = await main(["review", task.id, "--accept", "--json"], ctx);
  expect(json.code).toBe(1);
  const parsed = JSON.parse(json.out) as { merge?: string; resolution_task?: string; accepted?: boolean };
  expect(parsed.merge).toBe("conflict");
  expect(parsed.resolution_task).toMatch(/^t-/);
  expect(parsed.accepted).toBe(false);
});

test("run sync returns non-zero on conflict", async () => {
  const ctx = fakeCtx({ run: realRun, env: { PACER_API: "inprocess" } });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  const live = getRun(ctx, run.id)!;
  const wt = await integrationWorktree(ctx, live);
  // Diverge run branch from main so sync_base conflicts.
  await Bun.write(join(wt, "same.txt"), "run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run"], 10_000);
  await Bun.write(join(repo, "same.txt"), "main\n");
  await ctx.run(["git", "-C", repo, "add", "."], 10_000);
  await ctx.run(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "main"], 10_000);

  const deps: OpDeps = {
    delegate: async () => { throw new Error("no delegate"); },
  };
  // Wire callOp path used by runCmd.
  const got = await callOp(ctx, "run.sync_base", { id: run.id, expect_rev: getRun(ctx, run.id)!.rev }, deps);
  const r = got as { ok: boolean; resolution_task?: string };
  expect(r.ok).toBe(false);
  expect(r.resolution_task).toMatch(/^t-/);

  const out = await runCmd(["sync", run.id], ctx, deps);
  expect(out.code).toBe(1);
  expect(out.out).toContain(r.resolution_task!);
});
