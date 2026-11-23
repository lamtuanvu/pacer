// Run branch, integration worktree and per-run merge lock (Phase 5).
// Lazily creates `pacer/run-<10 base32>` from the base tip; all merges into one
// run go through one integration worktree under the task worktrees directory,
// serialized by withMergeLock. Spec: "Run branch beyond the happy path".
import { createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { gitInfo, realpathSafe } from "../core/git";
import { resolveWorktreeBase, taskWorktreesDir, worktreeDirty } from "../supervisor/worktree";
import { createTask, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { AgentStep } from "./schema";
import {
  getRun, replaceRunConflicts, setRunBranch, setRunConflict,
  stepByTask, taskByRequestId, workflowDatabase, type RunConflict, type RunRow,
} from "./store";
import { enqueueWakeup, stepWakeRef } from "./wakeups";
import { dataPreamble } from "./template";

/** Kinds that edit the tree by default. Research/review stay off unless
 *  `code: true`. Docs and unfamiliar-code write files so they count as code. */
const CODE_KINDS = new Set([
  "boilerplate", "tests", "rename", "migration", "feature", "debug", "refactor", "performance",
  "docs", "unfamiliar-code",
]);

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** Scrub absolute machine paths from git error text before surfacing. */
function cleanLine(s: string): string {
  return firstLine(s).replace(/\/(?:Users|Volumes|home|tmp)\/[^\s:]+/g, "<path>");
}

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

/**
 * Longest merge/publish holder can reach ~490s (integrationWorktreeUnlocked
 * 60+30+60 plus push/list/create). Stale takeover must sit above that (R2-F7/M6).
 * Heartbeat in withLock refreshes mtime every 30s while held.
 */
const MERGE_LOCK_TIMEOUT_MS = 150_000;
const MERGE_LOCK_STALE_MS = 540_000;

/** Serialize merges (and branch creation) for one run. */
export function withMergeLock<T>(
  ctx: Ctx,
  runId: string,
  fn: () => Promise<T> | T,
  o: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  return withLock(ctx, lockName(runId), fn, {
    timeoutMs: o.timeoutMs ?? MERGE_LOCK_TIMEOUT_MS,
    staleMs: o.staleMs ?? MERGE_LOCK_STALE_MS,
  }).catch((error: unknown) => {
    if (error instanceof Error && /^timed out waiting for /.test(error.message)) {
      throw new CoreError("unavailable", `merge lock timed out for ${runId}`);
    }
    throw error;
  });
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
  const abbrev = await ctx.run(["git", "-C", top, "rev-parse", "--abbrev-ref", "HEAD"], 10_000);
  const headName = abbrev.stdout.trim();
  if (abbrev.code !== 0 || !headName || headName === "HEAD") {
    throw new CoreError("invalid_input", "run branch base cannot be a detached HEAD; set execution.baseBranch");
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
  // Prefer the remote-tracking form when present; never store detached HEAD.
  const baseRef = !resolved.base || resolved.base === "HEAD" ? headName : resolved.base;
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
  let added = await ctx.run(["git", "-C", top, "worktree", "add", "-q", path, ensured.branch], 60_000);
  if (added.code !== 0 && !existsSync(path)) {
    await ctx.run(["git", "-C", top, "worktree", "prune"], 30_000);
    added = await ctx.run(["git", "-C", top, "worktree", "add", "-q", path, ensured.branch], 60_000);
  }
  if (added.code !== 0) {
    if (existsSync(path)) return path;
    throw new CoreError("unavailable", `cannot create integration worktree: ${cleanLine(added.stderr) || `exit ${added.code}`}`);
  }
  return path;
}

/** True when `branch` is already an ancestor of `runBranch` (conflicting work is in). */
async function isAncestorOfRun(
  ctx: Ctx, top: string, branch: string, runBranch: string,
): Promise<boolean> {
  const check = await ctx.run(
    ["git", "-C", top, "merge-base", "--is-ancestor", branch, runBranch],
    10_000,
  );
  return check.code === 0;
}

/**
 * After a successful accept merge (or plain accept), clear only conflict entries
 * whose conflicting branch is now an ancestor of the run branch (R2-F1).
 */
async function clearResolvedConflicts(
  ctx: Ctx, run: RunRow, top: string, taskId: string,
): Promise<void> {
  const live = getRun(ctx, run.id) ?? run;
  if (!live.branch || !live.conflict?.length) return;
  const remaining: RunConflict[] = [];
  for (const entry of live.conflict) {
    const related = entry.resolutionTaskId === taskId || entry.taskId === taskId
      || entry.branch === `pacer/${taskId}`;
    if (!related) {
      remaining.push(entry);
      continue;
    }
    // Only clear when the conflicting work is actually on the run branch.
    if (await isAncestorOfRun(ctx, top, entry.branch, live.branch)) continue;
    remaining.push(entry);
  }
  if (remaining.length !== live.conflict.length) {
    replaceRunConflicts(ctx, live.id, remaining);
  }
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

/** Allowlisted child env for engine-owned git (no PACER_*; same as syncBase). */
function gitQuietEnv(ctx: Ctx): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    PATH: ctx.env.PATH ?? process.env.PATH,
    HOME: ctx.env.HOME ?? process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
  };
  for (const [name, value] of Object.entries(ctx.env)) {
    if (value === undefined || name.startsWith("PACER_")) continue;
    if (name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE") continue;
    if (name.startsWith("GIT_") || name.startsWith("GH_") || name.startsWith("GCM_")
      || name.startsWith("SSH_") || name === "SSH_AUTH_SOCK"
      || name === "ALL_PROXY" || name.endsWith("_CA_BUNDLE") || name === "NODE_EXTRA_CA_CERTS"
      || name === "http_proxy" || name === "https_proxy" || name === "HTTP_PROXY" || name === "HTTPS_PROXY"
      || name === "no_proxy" || name === "NO_PROXY" || name === "LANG" || name === "LC_ALL") {
      env[name] = value;
    }
  }
  return env;
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
  let run = step ? getRun(ctx, step.runId) : null;
  // Conflict-resolution tasks are not step-attached; find them via the run marker.
  // Swallow all lookup errors (fail-safe: fall through to ordinary accept). Documented.
  if (!run?.branch) {
    try {
      const row = workflowDatabase(ctx).query<{ id: string }, [string, string]>(
        `SELECT id FROM workflow_runs
         WHERE conflict IS NOT NULL
           AND json_valid(conflict)
           AND (
             json_extract(conflict, '$.resolutionTaskId') = ?
             OR EXISTS (
               SELECT 1 FROM json_each(conflict) AS j
               WHERE json_extract(j.value, '$.resolutionTaskId') = ?
             )
           )
         LIMIT 1`,
      ).get(taskId, taskId);
      if (row) run = getRun(ctx, row.id);
    } catch {
      run = null;
    }
  }
  if (!run?.branch) return null;
  // Terminal runs: accept the verdict without merging (settle already dropped the
  // integration worktree; recreating it or enqueueing wake-ups would leak state).
  const RUN_TERMINAL = ["done", "failed", "stopped"] as const;
  if (RUN_TERMINAL.includes(run.status as typeof RUN_TERMINAL[number])) {
    return { merged: true };
  }
  const task = readTask(ctx, taskId);
  if (!task) return null;

  const taskBranch = `pacer/${taskId}`;
  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (RUN_TERMINAL.includes(live.status as typeof RUN_TERMINAL[number])) {
      return { merged: true };
    }
    const top = await resolveRepoTop(ctx, live.repo);
    // F1: --quiet makes a missing ref exit 1 (locale-independent). Only exit 1
    // means absent; every other non-zero (incl. 128 / timeout) stays unavailable.
    const hasBranch = await ctx.run(
      ["git", "-C", top, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch}`],
      5_000,
      { env: { ...ctx.env, LC_ALL: "C", LANG: "C" } },
    );
    if (hasBranch.code !== 0) {
      if (hasBranch.code !== 1) {
        throw new CoreError(
          "unavailable",
          `cannot resolve task branch ${taskBranch}: ${cleanLine(hasBranch.stderr) || `exit ${hasBranch.code}`}`,
        );
      }
      // Research / current-placement / cleaned worktree / resolution with no branch:
      // accept the verdict but only clear markers whose conflicting branch is already in.
      // Dirty check is skipped: there is nothing to merge (R2-F8).
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }

    // Ahead of the task's own base (not the run tip) so a moved base alone is not "ahead" (R2-F4).
    // If baseSha drifted to the task tip (ask/answer resume used to rewrite it to HEAD),
    // fall back to run..task so real commits are still merged.
    let baseRange = task.baseSha
      ? `${task.baseSha}..${taskBranch}`
      : `${live.branch}..${taskBranch}`;
    const ahead = await ctx.run(
      ["git", "-C", top, "rev-list", "--count", baseRange],
      10_000,
    );
    let aheadN = ahead.code === 0 ? Number(ahead.stdout.trim()) : NaN;
    if (aheadN === 0 && task.baseSha) {
      const vsRun = await ctx.run(
        ["git", "-C", top, "rev-list", "--count", `${live.branch}..${taskBranch}`],
        10_000,
      );
      const vsRunN = vsRun.code === 0 ? Number(vsRun.stdout.trim()) : 0;
      if (vsRunN > 0) {
        aheadN = vsRunN;
        baseRange = `${live.branch}..${taskBranch}`;
      }
    }
    if (aheadN === 0) {
      // M7: dirty check only when exists AND ahead — zero-ahead with untracked notes is plain accept.
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }

    // Dirty check only when we will merge a real pacer/<id> branch that is ahead (R2-F8/M7).
    const worktree = task.worktree ?? task.result?.worktree;
    if (worktree) {
      const dirty = await worktreeDirty(ctx, worktree);
      if (dirty === true) {
        throw new CoreError("invalid_input", "uncommitted changes in the task worktree");
      }
    }

    const wt = await integrationWorktreeUnlocked(ctx, live);
    // Crash leftover: clear an interrupted merge before starting another.
    if ((await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0) {
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
    }
    const signoff = mergeSignoffEnabled(top);
    const argv = [
      "git", "-C", wt,
      "-c", "user.email=pacer@localhost", "-c", "user.name=pacer",
      "-c", "core.hooksPath=/dev/null",
      "merge", "--no-ff", "--no-edit",
      ...(signoff ? ["--signoff"] : []),
      "-m", `Accept ${taskId} into ${live.branch}`,
      taskBranch,
    ];
    const quiet = gitQuietEnv(ctx);
    const merged = await ctx.run(argv, 60_000, { env: quiet });
    if (merged.code === 0) {
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }

    const conflicted = /CONFLICT/i.test(merged.stdout + merged.stderr)
      || (await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0;
    if (conflicted) {
      const files = (await ctx.run(["git", "-C", wt, "diff", "--name-only", "--diff-filter=U"], 15_000)).stdout.trim();
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
      const resolution = createConflictResolutionTask(ctx, live, task, taskBranch, files);
      return { merged: false, merge: "conflict", resolution_task: resolution.id };
    }
    throw new CoreError("unavailable", `merge failed: ${cleanLine(merged.stderr) || cleanLine(merged.stdout) || `exit ${merged.code}`}`);
  });
}

const CONFLICT_FILES_CAP = 4 * 1024;

function resolutionStillOpen(task: TaskRecord): boolean {
  // Dedupe only against a prior resolution that has not been reviewed yet (R2-F2).
  return !task.review;
}

function createConflictResolutionTask(
  ctx: Ctx, run: RunRow, task: TaskRecord | { id: string; rev: number }, taskBranch: string, files: string,
): TaskRecord {
  // Include an attempt counter so a reviewed/closed prior does not block a fresh resolution (R2-F2).
  let attempt = 1;
  let requestId = `wfconflict:${run.id}:${task.id}:${task.rev}:${attempt}`;
  let prior = taskByRequestId(ctx, requestId);
  // Also recognize the pre-R2-F2 requestId shape for in-flight open tasks.
  if (!prior) {
    const legacy = taskByRequestId(ctx, `wfconflict:${run.id}:${task.id}:${task.rev}`);
    if (legacy && resolutionStillOpen(legacy)) prior = legacy;
  }
  while (prior && !resolutionStillOpen(prior)) {
    attempt += 1;
    requestId = `wfconflict:${run.id}:${task.id}:${task.rev}:${attempt}`;
    prior = taskByRequestId(ctx, requestId);
  }
  if (prior && resolutionStillOpen(prior)) {
    setRunConflict(ctx, run.id, {
      taskId: task.id,
      branch: taskBranch,
      resolutionTaskId: prior.id,
    });
    return prior;
  }

  const rawFiles = files.trim() || "(unknown)";
  const capped = rawFiles.length > CONFLICT_FILES_CAP
    ? `${rawFiles.slice(0, CONFLICT_FILES_CAP)}\n…(truncated)`
    : rawFiles;
  const nonce = randomBytes(4).toString("hex");
  const goal = [
    `Manual conflict resolution for run ${run.id} (person or orchestrator; not auto-started).`,
    `Run branch: ${run.branch}. Conflicting task branch: ${taskBranch}.`,
    dataPreamble(nonce),
    `--- data ${nonce} conflicting-paths ---`,
    capped,
    `--- end data ${nonce} ---`,
    `Merge the fix into ${run.branch} on a pacer/<this-task> branch, then accept this task.`,
  ].join("\n");
  const resolution = createTask(ctx, {
    brief: { goal, repo: run.repo, base: run.branch },
    kind: "debug",
    requestedExecutor: null,
    timeoutS: 3600,
    title: `Conflict · ${task.id}`.slice(0, 60),
    requestId,
  });
  // Manual task: needs_input so the 600s never-started sweep cannot mark it failed.
  updateTask(ctx, resolution.id, t => {
    t.state = "needs_input";
    t.question = {
      text: `Resolve merge conflict for ${task.id} into ${run.branch}, then accept this task.`,
      at: ctx.now,
    };
  });
  setRunConflict(ctx, run.id, {
    taskId: task.id,
    branch: taskBranch,
    resolutionTaskId: resolution.id,
  });

  // Wake the orchestrator on the real conflicting step when known; else the run id.
  const owning = stepByTask(ctx, task.id);
  if (run.orchestratorTaskId || run.planner) {
    try {
      enqueueWakeup(ctx, {
        runId: run.id,
        cause: "step_failed",
        ref: owning
          ? stepWakeRef(run.id, owning.stepId, owning.attempt, owning.branch)
          : stepWakeRef(run.id, "conflict", 1),
        createdAt: ctx.now,
      });
    } catch {
      // Wakeup is best-effort; the durable run.conflict marker is authoritative.
    }
  }
  return readTask(ctx, resolution.id) ?? resolution;
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
    if (!live.branch || !live.baseRef) throw new CoreError("invalid_input", `run ${runId} has no branch to sync`);
    const baseRef = live.baseRef;
    const wt = await integrationWorktreeUnlocked(ctx, live);
    const top = await resolveRepoTop(ctx, live.repo);
    const quiet = gitQuietEnv(ctx);
    // Fetch only remote-tracking bases (origin/*); local feature/x must not hit the network (R2-F5).
    if (baseRef.startsWith("origin/")) {
      const fetched = await ctx.run(
        ["git", "-C", top, "fetch", "--quiet", "origin"],
        120_000,
        { env: quiet },
      );
      if (fetched.code !== 0) {
        throw new CoreError(
          "unavailable",
          `sync_base fetch failed: ${cleanLine(fetched.stderr) || cleanLine(fetched.stdout) || `exit ${fetched.code}`}`,
        );
      }
    }
    // Resolve the base tip without checking it out in the main worktree.
    const tip = await ctx.run(
      ["git", "-C", top, "rev-parse", "--verify", `${baseRef}^{commit}`],
      10_000,
      { env: quiet },
    );
    const sha = tip.stdout.trim();
    if (tip.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      throw new CoreError("unavailable", `cannot resolve base ${baseRef}: ${cleanLine(tip.stderr)}`);
    }
    // R3-I5: abort a leftover MERGE_HEAD before merging (same as accept).
    if ((await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0) {
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
    }
    const signoff = mergeSignoffEnabled(top);
    const argv = [
      "git", "-C", wt,
      "-c", "user.email=pacer@localhost", "-c", "user.name=pacer",
      "-c", "core.hooksPath=/dev/null",
      "merge", "--no-ff", "--no-edit",
      ...(signoff ? ["--signoff"] : []),
      "-m", `Sync base ${live.baseRef} into ${live.branch}`,
      sha,
    ];
    const merged = await ctx.run(argv, 60_000, { env: quiet });
    if (merged.code === 0) {
      // R3-I5: clear sync_base entries whose conflicting base SHA is now an ancestor.
      await clearResolvedConflicts(ctx, live, top, `base:${live.baseRef}`);
      return { ok: true, run: getRun(ctx, run.id) ?? live };
    }

    const conflicted = /CONFLICT/i.test(merged.stdout + merged.stderr)
      || (await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0;
    if (conflicted) {
      const files = (await ctx.run(["git", "-C", wt, "diff", "--name-only", "--diff-filter=U"], 15_000)).stdout.trim();
      await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
      // Store the conflicting base SHA (not the moving ref name) so ancestor clear works (R3-I5).
      const resolution = createConflictResolutionTask(
        ctx, live, { id: `base:${live.baseRef}`, rev: live.rev }, sha, files,
      );
      return { ok: false, merge: "conflict", resolution_task: resolution.id, run: getRun(ctx, live.id) ?? live };
    }
    throw new CoreError("unavailable", `sync_base failed: ${cleanLine(merged.stderr) || cleanLine(merged.stdout) || `exit ${merged.code}`}`);
  });
}
