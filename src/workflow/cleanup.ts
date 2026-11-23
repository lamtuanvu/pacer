// Run stop/cleanup helpers for the run branch and integration worktree (Phase 5).
// Stop never deletes the run branch or remotes; terminal settle removes the integration
// worktree and merged task branches only. Person-only cleanupRun may delete the local
// run branch when delete_branch is true (D7). Never force-pushes; never touches remotes.
import { existsSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { gitInfo } from "../core/git";
import { removeTaskWorktree } from "../supervisor/worktree";
import {
  clearRunBranch, clearRunConflict, getRun, stepsOfRun, type RunRow,
} from "./store";
import {
  integrationWorktreePath, withMergeLock,
} from "./branch";

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

export type BranchReport = { branch?: string; ahead?: number };

/** Commits the run branch is ahead of its recorded base tip (or base_ref). */
export async function runBranchAhead(ctx: Ctx, run: RunRow): Promise<number | undefined> {
  if (!run.branch) return undefined;
  const base = run.baseSha || run.baseRef;
  if (!base) return undefined;
  const count = await ctx.run(
    ["git", "-C", run.repo, "rev-list", "--count", `${base}..${run.branch}`],
    15_000,
  );
  if (count.code !== 0) return undefined;
  const n = Number(count.stdout.trim());
  return Number.isFinite(n) ? n : undefined;
}

export async function branchReportFor(ctx: Ctx, run: RunRow): Promise<BranchReport> {
  if (!run.branch) return {};
  const ahead = await runBranchAhead(ctx, run);
  return ahead === undefined ? { branch: run.branch } : { branch: run.branch, ahead };
}

/** Remove the integration worktree if present. Safe when already gone. */
export async function removeIntegrationWorktree(ctx: Ctx, run: RunRow): Promise<void> {
  if (!run.branch) return;
  const info = await gitInfo(ctx.run, run.repo);
  if ("error" in info) return;
  const path = integrationWorktreePath(ctx, info.top, run.id);
  if (!existsSync(path)) return;
  await removeTaskWorktree(ctx, info.top, path, { force: true });
}

/**
 * Delete local task branches that are fully merged into the run branch.
 * Unmerged branches (rejected work) stay. Never deletes the run branch itself.
 */
export async function deleteMergedTaskBranches(ctx: Ctx, run: RunRow): Promise<string[]> {
  if (!run.branch) return [];
  const deleted: string[] = [];
  const seen = new Set<string>();
  for (const step of stepsOfRun(ctx, run.id)) {
    if (!step.taskId) continue;
    const branch = `pacer/${step.taskId}`;
    if (seen.has(branch) || branch === run.branch) continue;
    seen.add(branch);
    const exists = await ctx.run(["git", "-C", run.repo, "rev-parse", "--verify", `refs/heads/${branch}`], 10_000);
    if (exists.code !== 0) continue;
    // `git branch -d` checks merge into HEAD (often main), not the run branch.
    // After confirming the tip is an ancestor of the run branch, -D is the safe delete.
    const ancestor = await ctx.run(
      ["git", "-C", run.repo, "merge-base", "--is-ancestor", branch, run.branch],
      10_000,
    );
    if (ancestor.code !== 0) continue;
    const rm = await ctx.run(["git", "-C", run.repo, "branch", "-D", branch], 15_000);
    if (rm.code === 0) deleted.push(branch);
  }
  return deleted;
}

/** Terminal settle: drop the integration worktree and merged task branches; keep the run branch. */
export async function settleRunGitOnTerminal(
  ctx: Ctx, run: RunRow, o: { timeoutMs?: number } = {},
): Promise<void> {
  if (!run.branch) return;
  await withMergeLock(ctx, run.id, async () => {
    await removeIntegrationWorktree(ctx, run);
    await deleteMergedTaskBranches(ctx, run);
  }, { timeoutMs: o.timeoutMs });
}

export type CleanupInput = { deleteBranch: boolean; expectRev: number };
export type CleanupResult = {
  run: RunRow;
  deleted_branch: string | null;
  ahead?: number;
  /** Tip sha of the run branch before deletion (confirmation). */
  deleted_tip?: string | null;
  pr_url?: string;
};

/**
 * Person-only run cleanup. Removes any leftover integration worktree; deletes the local
 * run branch with `git branch -D` only when `deleteBranch` is true. Never touches remotes.
 */
export async function cleanupRun(ctx: Ctx, runId: string, input: CleanupInput): Promise<CleanupResult> {
  if (ctx.env.PACER_RUN_GRANT) {
    // Same refusal shape as an unknown id under a grant (person-only).
    throw new CoreError("not_allowed", "unknown run");
  }
  if (typeof input.deleteBranch !== "boolean") {
    throw new CoreError("invalid_input", "delete_branch must be a boolean");
  }
  if (!Number.isInteger(input.expectRev)) {
    throw new CoreError("invalid_input", "expect_rev must be an integer");
  }
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (run.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
  }
  const terminal = run.status === "done" || run.status === "failed" || run.status === "stopped";
  if (!terminal) {
    throw new CoreError("not_allowed", `run ${runId} is still ${run.status}; cleanup requires a terminal run`);
  }

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, runId) ?? run;
    if (live.rev !== input.expectRev) {
      throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${input.expectRev}`);
    }
    if (!(live.status === "done" || live.status === "failed" || live.status === "stopped")) {
      throw new CoreError("not_allowed", `run ${runId} is still ${live.status}; cleanup requires a terminal run`);
    }
    const tipSha = live.branch
      ? (await ctx.run(["git", "-C", live.repo, "rev-parse", "--verify", `refs/heads/${live.branch}`], 10_000)).stdout.trim() || null
      : null;
    const aheadBefore = await runBranchAhead(ctx, live);
    await removeIntegrationWorktree(ctx, live);
    await deleteMergedTaskBranches(ctx, live);

    let deleted: string | null = null;
    if (input.deleteBranch) {
      if (!live.branch) throw new CoreError("invalid_input", `run ${runId} has no branch to delete`);
      const exists = await ctx.run(
        ["git", "-C", live.repo, "rev-parse", "--verify", `refs/heads/${live.branch}`],
        10_000,
      );
      if (exists.code === 0) {
        const rm = await ctx.run(["git", "-C", live.repo, "branch", "-D", live.branch], 15_000);
        if (rm.code !== 0) {
          throw new CoreError("unavailable", `cannot delete run branch: ${firstLine(rm.stderr) || `exit ${rm.code}`}`);
        }
      }
      deleted = live.branch;
      clearRunBranch(ctx, live.id);
      // M1: clear conflict markers only when the branch is deleted (surviving branch may still hold conflicts).
      clearRunConflict(ctx, live.id);
    }

    const updated = getRun(ctx, live.id) ?? live;
    const ahead = await runBranchAhead(ctx, updated);
    return {
      run: updated,
      deleted_branch: deleted,
      ...(ahead === undefined && aheadBefore === undefined ? {} : { ahead: ahead ?? aheadBefore }),
      ...(tipSha ? { deleted_tip: tipSha } : {}),
      ...(updated.prUrl || live.prUrl ? { pr_url: updated.prUrl ?? live.prUrl } : {}),
    };
  });
}
