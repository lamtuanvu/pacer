// Run branch, integration worktree and per-run merge lock (Phase 5).
// Lazily creates `pacer/run-<10 base32>` from the base tip; all merges into one
// run go through one integration worktree under the task worktrees directory,
// serialized by withMergeLock. Spec: "Run branch beyond the happy path".
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { gitInfo, realpathSafe } from "../core/git";
import { resolveWorktreeBase, taskWorktreesDir } from "../supervisor/worktree";
import type { AgentStep } from "./schema";
import { getRun, setRunBranch, type RunRow } from "./store";

/** Kinds that edit the tree by default. Others (research/docs/review/…) stay off
 *  unless the step sets `code: true`. Unknown kinds also stay off. */
const CODE_KINDS = new Set([
  "boilerplate", "tests", "rename", "migration", "feature", "debug", "refactor", "performance",
]);

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** `run_<10 base32>` → `pacer/run-<10 base32>`. */
export function runBranchName(runId: string): string {
  const suffix = runId.startsWith("run_") ? runId.slice(4) : runId;
  return `pacer/run-${suffix}`;
}

/** Whether an agent / fan-out-each step should create or use the run branch. */
export function isCodeStep(step: Pick<AgentStep, "kind" | "role" | "code">): boolean {
  if (step.role === "orchestrator" || step.role === "reviewer") return false;
  if (step.code === false) return false;
  if (step.code === true) return true;
  if (!step.kind) return false;
  return CODE_KINDS.has(step.kind);
}

/** Lock file name fragment: run ids are already `[a-z0-9_]` but keep the lock helper happy. */
function lockName(runId: string): string {
  return `run-merge-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

/** Serialize merges (and branch creation) for one run. */
export function withMergeLock<T>(ctx: Ctx, runId: string, fn: () => Promise<T> | T): Promise<T> {
  return withLock(ctx, lockName(runId), fn);
}

export type RunBranchInfo = { branch: string; base_ref: string; base_sha: string };

async function resolveRepoTop(ctx: Ctx, repo: string): Promise<string> {
  const info = await gitInfo(ctx.run, repo);
  if ("error" in info) throw new CoreError("invalid_input", info.error);
  return info.top;
}

/** Create the run branch from the base tip if missing; idempotent under the merge lock. */
export async function ensureRunBranch(ctx: Ctx, run: RunRow): Promise<RunBranchInfo> {
  if (run.branch && run.baseRef && run.baseSha) {
    return { branch: run.branch, base_ref: run.baseRef, base_sha: run.baseSha };
  }
  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (live.branch && live.baseRef && live.baseSha) {
      return { branch: live.branch, base_ref: live.baseRef, base_sha: live.baseSha };
    }
    const top = await resolveRepoTop(ctx, live.repo);
    let configured: string | null = null;
    try {
      const { loadStrategy } = await import("../config/strategy");
      const { validateExecution } = await import("../config/execution");
      configured = validateExecution(loadStrategy(ctx).execution).baseBranch;
    } catch {
      configured = null;
    }
    const resolved = await resolveWorktreeBase(ctx, top, { worktreeBase: configured ? undefined : "head" }, configured, true);
    if ("error" in resolved) throw new CoreError("unavailable", resolved.error);
    const branch = runBranchName(live.id);
    const existing = await ctx.run(["git", "-C", top, "rev-parse", "--verify", `refs/heads/${branch}`], 10_000);
    if (existing.code !== 0) {
      const created = await ctx.run(["git", "-C", top, "branch", branch, resolved.sha], 10_000);
      if (created.code !== 0) {
        // A concurrent creator may have won; accept an existing ref at the same tip.
        const again = await ctx.run(["git", "-C", top, "rev-parse", "--verify", `refs/heads/${branch}`], 10_000);
        if (again.code !== 0) {
          throw new CoreError("unavailable", `cannot create run branch: ${firstLine(created.stderr) || `exit ${created.code}`}`);
        }
      }
    }
    const baseRef = resolved.base.startsWith("origin/") ? resolved.base.slice("origin/".length)
      : resolved.base === "HEAD" ? (await ctx.run(["git", "-C", top, "rev-parse", "--abbrev-ref", "HEAD"], 10_000)).stdout.trim() || "HEAD"
      : resolved.base;
    const info = { branch, base_ref: baseRef, base_sha: resolved.sha };
    setRunBranch(ctx, live.id, info);
    return info;
  });
}

function integrationPath(ctx: Ctx, top: string, runId: string): string {
  const real = realpathSafe(top);
  const tag = `${basename(real).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
  return join(taskWorktreesDir(ctx), tag, `run-${runId}`);
}

/** One integration worktree per run, checked out on the run branch. */
export async function integrationWorktree(ctx: Ctx, run: RunRow): Promise<string> {
  const ensured = await ensureRunBranch(ctx, run);
  const top = await resolveRepoTop(ctx, run.repo);
  const path = integrationPath(ctx, top, run.id);
  if (existsSync(path)) return path;
  return withMergeLock(ctx, run.id, async () => {
    if (existsSync(path)) return path;
    mkdirSync(join(path, ".."), { recursive: true });
    const added = await ctx.run(["git", "-C", top, "worktree", "add", "-q", path, ensured.branch], 60_000);
    if (added.code !== 0) {
      if (existsSync(path)) return path;
      throw new CoreError("unavailable", `cannot create integration worktree: ${firstLine(added.stderr) || `exit ${added.code}`}`);
    }
    return path;
  });
}
