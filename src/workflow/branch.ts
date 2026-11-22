// Run branch, integration worktree and per-run merge lock (Phase 5).
// Lazily creates `pacer/run-<10 base32>` from the base tip; all merges into one
// run go through one integration worktree under the task worktrees directory,
// serialized by withMergeLock. Spec: "Run branch beyond the happy path".
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { gitInfo, realpathSafe } from "../core/git";
import { resolveWorktreeBase, taskWorktreesDir, worktreeDirty } from "../supervisor/worktree";
import { createTask, readTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { AgentStep } from "./schema";
import { getRun, setRunBranch, stepByTask, type RunRow } from "./store";
import { enqueueWakeup, stepWakeRef } from "./wakeups";

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

async function ensureRunBranchUnlocked(ctx: Ctx, run: RunRow): Promise<RunBranchInfo> {
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
}

/** Create the run branch from the base tip if missing; idempotent under the merge lock. */
export async function ensureRunBranch(ctx: Ctx, run: RunRow): Promise<RunBranchInfo> {
  if (run.branch && run.baseRef && run.baseSha) {
    return { branch: run.branch, base_ref: run.baseRef, base_sha: run.baseSha };
  }
  return withMergeLock(ctx, run.id, () => ensureRunBranchUnlocked(ctx, run));
}

function integrationPath(ctx: Ctx, top: string, runId: string): string {
  const real = realpathSafe(top);
  const tag = `${basename(real).replace(/[^A-Za-z0-9._-]/g, "_")}-${createHash("sha1").update(real).digest("hex").slice(0, 8)}`;
  return join(taskWorktreesDir(ctx), tag, `run-${runId}`);
}

async function integrationWorktreeUnlocked(ctx: Ctx, run: RunRow): Promise<string> {
  const ensured = await ensureRunBranchUnlocked(ctx, run);
  const top = await resolveRepoTop(ctx, run.repo);
  const path = integrationPath(ctx, top, run.id);
  if (existsSync(path)) return path;
  mkdirSync(join(path, ".."), { recursive: true });
  const added = await ctx.run(["git", "-C", top, "worktree", "add", "-q", path, ensured.branch], 60_000);
  if (added.code !== 0) {
    if (existsSync(path)) return path;
    throw new CoreError("unavailable", `cannot create integration worktree: ${firstLine(added.stderr) || `exit ${added.code}`}`);
  }
  return path;
}

/** One integration worktree per run, checked out on the run branch. */
export async function integrationWorktree(ctx: Ctx, run: RunRow): Promise<string> {
  const live = getRun(ctx, run.id) ?? run;
  if (live.branch) {
    const top = await resolveRepoTop(ctx, live.repo);
    const path = integrationPath(ctx, top, live.id);
    if (existsSync(path)) return path;
  }
  return withMergeLock(ctx, run.id, () => integrationWorktreeUnlocked(ctx, run));
}

/** Same as integrationWorktree but must be called while holding withMergeLock (no nested lock). */
export async function integrationWorktreeUnderLock(ctx: Ctx, run: RunRow): Promise<string> {
  return integrationWorktreeUnlocked(ctx, run);
}

/** Absolute path of the integration worktree directory (may not exist yet). */
export function integrationWorktreePath(ctx: Ctx, repoTop: string, runId: string): string {
  return integrationPath(ctx, repoTop, runId);
}

/** Repo setting `workflow.merge_signoff` from `<repo>/.pacer/workflow.json`. */
export function mergeSignoffEnabled(repoTop: string): boolean {
  try {
    const raw = readFileSync(join(repoTop, ".pacer", "workflow.json"), "utf8");
    const parsed = JSON.parse(raw) as { merge_signoff?: unknown };
    return parsed.merge_signoff === true;
  } catch {
    return false;
  }
}

export type AcceptMergeResult =
  | { merged: true }
  | { merged: false; merge: "conflict"; resolution_task: string };

/**
 * When `taskId` belongs to a run that has a branch, merge `pacer/<taskId>` into the
 * run branch under the merge lock. Returns null when the task is not a run-branch
 * task (ordinary accept path). On conflict: aborts, creates a resolution task, no verdict.
 */
export async function mergeTaskOnAccept(ctx: Ctx, taskId: string): Promise<AcceptMergeResult | null> {
  const step = stepByTask(ctx, taskId);
  if (!step) return null;
  const run = getRun(ctx, step.runId);
  if (!run?.branch) return null;
  const task = readTask(ctx, taskId);
  if (!task) return null;

  const worktree = task.worktree ?? task.result?.worktree;
  if (worktree) {
    const dirty = await worktreeDirty(ctx, worktree);
    if (dirty === true) {
      throw new CoreError("invalid_input", "uncommitted changes in the task worktree");
    }
  }

  const taskBranch = `pacer/${taskId}`;
  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    const wt = await integrationWorktreeUnlocked(ctx, live);
    const top = await resolveRepoTop(ctx, live.repo);
    const signoff = mergeSignoffEnabled(top);
    const argv = [
      "git", "-C", wt,
      "-c", "user.email=pacer@localhost", "-c", "user.name=pacer",
      "merge", "--no-ff", "--no-edit",
      ...(signoff ? ["--signoff"] : []),
      "-m", `Accept ${taskId} into ${live.branch}`,
      taskBranch,
    ];
    const merged = await ctx.run(argv, 60_000);
    if (merged.code === 0) return { merged: true };

    const conflicted = /CONFLICT/i.test(merged.stdout + merged.stderr)
      || (await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0;
    if (conflicted) {
      const files = (await ctx.run(["git", "-C", wt, "diff", "--name-only", "--diff-filter=U"], 15_000)).stdout.trim();
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
      const resolution = createConflictResolutionTask(ctx, live, task, taskBranch, files);
      return { merged: false, merge: "conflict", resolution_task: resolution.id };
    }
    throw new CoreError("unavailable", `merge failed: ${firstLine(merged.stderr) || firstLine(merged.stdout) || `exit ${merged.code}`}`);
  });
}

function createConflictResolutionTask(
  ctx: Ctx, run: RunRow, task: TaskRecord | { id: string; rev: number }, taskBranch: string, files: string,
): TaskRecord {
  const fileList = files.trim() || "(unknown)";
  const goal = [
    `Resolve merge conflict for run ${run.id}.`,
    `Run branch: ${run.branch}. Task branch: ${taskBranch}.`,
    `Conflicting paths:\n${fileList}`,
    `Merge the fix into ${run.branch} and report when the conflict is clear.`,
  ].join("\n");
  const resolution = createTask(ctx, {
    brief: { goal, repo: run.repo, base: run.branch },
    kind: "debug",
    requestedExecutor: null,
    timeoutS: 3600,
    title: `Conflict · ${task.id}`.slice(0, 60),
    requestId: `wfconflict:${run.id}:${task.id}:${task.rev}`,
  });
  // Phase 2: wake the orchestrator when the run has one (reuse step_failed; no dedicated conflict cause yet).
  if (run.orchestratorTaskId || run.planner) {
    try {
      enqueueWakeup(ctx, {
        runId: run.id,
        cause: "step_failed",
        ref: stepWakeRef(run.id, `conflict:${task.id}`, 1),
        createdAt: ctx.now,
      });
    } catch {
      // Wakeup is best-effort; the resolution task is the durable record.
    }
  }
  return resolution;
}

/** The run branch tip a retry of this step task should start from, or null when not a run-branch task. */
export function runBranchBaseForRetry(ctx: Ctx, taskId: string): string | null {
  const step = stepByTask(ctx, taskId);
  if (!step) return null;
  const run = getRun(ctx, step.runId);
  return run?.branch ?? null;
}

export type SyncBaseResult =
  | { ok: true; run: RunRow }
  | { ok: false; merge: "conflict"; resolution_task: string; run: RunRow };

/**
 * Merge the base branch's current tip into the run branch (same conflict path as accept).
 * Library form of `run.sync_base`; the op arrives in a later task.
 */
export async function syncBase(ctx: Ctx, runId: string, expectRev: number): Promise<SyncBaseResult> {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  if (!run.branch || !run.baseRef) throw new CoreError("invalid_input", `run ${runId} has no branch to sync`);

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (live.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
    const wt = await integrationWorktreeUnlocked(ctx, live);
    const top = await resolveRepoTop(ctx, live.repo);
    // Resolve the base tip without checking it out in the main worktree.
    const tip = await ctx.run(["git", "-C", top, "rev-parse", "--verify", `${live.baseRef}^{commit}`], 10_000);
    const sha = tip.stdout.trim();
    if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new CoreError("unavailable", `cannot resolve base ${live.baseRef}: ${firstLine(tip.stderr)}`);
    }
    const signoff = mergeSignoffEnabled(top);
    const argv = [
      "git", "-C", wt,
      "-c", "user.email=pacer@localhost", "-c", "user.name=pacer",
      "merge", "--no-ff", "--no-edit",
      ...(signoff ? ["--signoff"] : []),
      "-m", `Sync base ${live.baseRef} into ${live.branch}`,
      sha,
    ];
    const merged = await ctx.run(argv, 60_000);
    if (merged.code === 0) return { ok: true, run: getRun(ctx, run.id) ?? live };

    const conflicted = /CONFLICT/i.test(merged.stdout + merged.stderr)
      || (await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0;
    if (conflicted) {
      const files = (await ctx.run(["git", "-C", wt, "diff", "--name-only", "--diff-filter=U"], 15_000)).stdout.trim();
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
      const resolution = createConflictResolutionTask(ctx, live, { id: `base:${live.baseRef}`, rev: live.rev }, live.baseRef!, files);
      return { ok: false, merge: "conflict", resolution_task: resolution.id, run: live };
    }
    throw new CoreError("unavailable", `sync_base failed: ${firstLine(merged.stderr) || firstLine(merged.stdout) || `exit ${merged.code}`}`);
  });
}
