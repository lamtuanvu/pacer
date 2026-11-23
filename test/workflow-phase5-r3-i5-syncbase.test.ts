import { expect, test } from "bun:test";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import {
  getRun, insertRun, setRunConflict, workflowDatabase,
} from "../src/workflow/store";
import {
  ensureRunBranch, integrationWorktree, syncBase,
} from "../src/workflow/branch";
import { hasUnresolvedConflictTask } from "../src/workflow/publish";

async function seededBranchedRun() {
  const ctx = fakeCtx({ run: realRun });
  const repo = gitRepo();
  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  return { ctx, repo, run: getRun(ctx, run.id)! };
}

test("R3-I5: leftover MERGE_HEAD is aborted before syncBase merges", async () => {
  const { ctx, run } = await seededBranchedRun();
  const live = getRun(ctx, run.id)!;
  const wt = await integrationWorktree(ctx, live);
  const top = live.repo;

  // Build a divergent commit reachable from the worktree, then leave MERGE_HEAD.
  await Bun.write(join(wt, "clash.txt"), "run-side\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run-side"], 10_000);
  const runTip = (await ctx.run(["git", "-C", wt, "rev-parse", "HEAD"], 10_000)).stdout.trim();

  // Reset worktree soft and create an alternate tip that conflicts, then merge --no-commit.
  await ctx.run(["git", "-C", wt, "reset", "--hard", "HEAD~1"], 10_000);
  await Bun.write(join(wt, "clash.txt"), "other-side\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "other"], 10_000);
  const otherTip = (await ctx.run(["git", "-C", wt, "rev-parse", "HEAD"], 10_000)).stdout.trim();
  await ctx.run(["git", "-C", wt, "reset", "--hard", runTip], 10_000);
  const merge = await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "merge", "--no-commit", "--no-ff", otherTip], 30_000);
  // Conflict or clean-with-MERGE_HEAD both leave MERGE_HEAD until aborted/committed.
  expect(merge.code === 0 || merge.code === 1).toBe(true);
  expect((await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code).toBe(0);

  // Point base at the current run tip so syncBase's merge is a no-op after abort.
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET base_ref = ?, base_sha = ? WHERE id = ?",
  ).run(live.branch!, runTip, live.id);

  const beforeConflicts = getRun(ctx, live.id)!.conflict?.length ?? 0;
  const result = await syncBase(ctx, live.id, getRun(ctx, live.id)!.rev);
  expect(result.ok).toBe(true);
  expect((await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code).not.toBe(0);
  const after = getRun(ctx, live.id)!;
  expect(after.conflict?.length ?? 0).toBe(beforeConflicts);
  void top;
});

test("R3-I5: clean sync clears sync_base entries whose base SHA is now an ancestor", async () => {
  const { ctx, run } = await seededBranchedRun();
  const live = getRun(ctx, run.id)!;
  const tip = (await ctx.run(
    ["git", "-C", live.repo, "rev-parse", "--verify", `refs/heads/${live.branch}`],
    10_000,
  )).stdout.trim();

  // Seed a sync_base conflict entry keyed by base:ref with branch=sha (the fixed shape).
  const resTask = "t_res_sync";
  setRunConflict(ctx, live.id, {
    taskId: `base:${live.baseRef}`,
    branch: tip,
    resolutionTaskId: resTask,
  });
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(true);

  const result = await syncBase(ctx, live.id, getRun(ctx, live.id)!.rev);
  expect(result.ok).toBe(true);
  // Tip SHA is already an ancestor of the run branch → marker cleared.
  expect(hasUnresolvedConflictTask(ctx, live.id)).toBe(false);
  expect(getRun(ctx, live.id)!.conflict?.some(e => e.resolutionTaskId === resTask)).toBeFalsy();
});

test("R3-I5: sync conflict stores the base SHA not the moving ref name", async () => {
  const ctx = fakeCtx({ run: realRun });
  // Bare origin so we can advance base independently.
  const bare = tmpDir();
  await ctx.run(["git", "init", "--bare", bare], 10_000);
  const repo = gitRepo();
  await ctx.run(["git", "-C", repo, "remote", "add", "origin", bare], 10_000);
  await ctx.run(["git", "-C", repo, "push", "-u", "origin", "HEAD:main"], 30_000);

  workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/feat", version: 1, repo, brief: "b", stepMode: "plain" });
  await ensureRunBranch(ctx, run);
  let live = getRun(ctx, run.id)!;

  // Diverge run branch and origin/main so sync conflicts.
  const wt = await integrationWorktree(ctx, live);
  await Bun.write(join(wt, "clash.txt"), "run\n");
  await ctx.run(["git", "-C", wt, "add", "."], 10_000);
  await ctx.run(["git", "-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "run"], 10_000);

  const clone = tmpDir();
  await ctx.run(["git", "clone", "-b", "main", bare, clone], 30_000);
  await Bun.write(join(clone, "clash.txt"), "origin\n");
  await ctx.run(["git", "-C", clone, "add", "."], 10_000);
  await ctx.run(["git", "-C", clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "origin"], 10_000);
  await ctx.run(["git", "-C", clone, "push", "origin", "HEAD:main"], 30_000);

  live = getRun(ctx, run.id)!;
  // Point base at origin/main for fetch path.
  const { setRunBranch } = await import("../src/workflow/store");
  // base_ref may already be main; force origin/main.
  workflowDatabase(ctx).query(
    "UPDATE workflow_runs SET base_ref = ? WHERE id = ?",
  ).run("origin/main", live.id);
  live = getRun(ctx, run.id)!;

  const result = await syncBase(ctx, live.id, live.rev);
  expect(result.ok).toBe(false);
  const entry = getRun(ctx, live.id)!.conflict?.find(e => e.taskId.startsWith("base:"));
  expect(entry).toBeTruthy();
  expect(entry!.branch).toMatch(/^[0-9a-f]{40,64}$/);
  expect(entry!.branch).not.toBe("origin/main");
  expect(entry!.branch).not.toBe("main");
});
