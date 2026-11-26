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
import { removeTaskWorktree, resolveWorktreeBase, taskWorktreesDir, worktreeDirty } from "../supervisor/worktree";
import { createTask, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import { isCodeStep } from "./schema";
import {
  branchOwner, clearRunBranch, clearRunConflict, generatedChildren, getDefinition, getRun, replaceRunConflicts,
  setRunBranch, setRunConflict,
  stepByTask, stepByTaskLineage, taskByRequestId, workflowDatabase, type RunConflict, type RunRow,
} from "./store";
import { enqueueWakeup, stepWakeRef } from "./wakeups";
import { dataPreamble } from "./template";
import { awaitsReview, closeConflictRecord } from "./review";

export { isCodeStep };

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

/** Create the run branch from the base tip if missing; idempotent under the merge
 *  lock. A generated child uses (and creates) its owner's branch. */
export async function ensureRunBranch(ctx: Ctx, of: RunRow): Promise<RunBranchInfo> {
  const run = branchOwner(ctx, of);
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
    if (await isAncestorOfRun(ctx, top, entry.branch, live.branch)) {
      if (entry.resolutionTaskId !== taskId) closeConflictRecord(ctx, entry.resolutionTaskId);
      continue;
    }
    remaining.push(entry);
  }
  if (remaining.length !== live.conflict.length) {
    replaceRunConflicts(ctx, live.id, remaining);
  }
}

/** One integration worktree per run, checked out on the run branch. */
export async function integrationWorktree(ctx: Ctx, of: RunRow): Promise<string> {
  const run = branchOwner(ctx, of);
  const live = run;
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

const RUN_TERMINAL: readonly RunRow["status"][] = ["done", "failed", "stopped"];

/** True when `taskId` works for an agent or fan-out step that changes code. */
function isCodeTask(ctx: Ctx, taskId: string): boolean {
  const step = stepByTaskLineage(ctx, taskId);
  const run = step ? getRun(ctx, step.runId) : null;
  if (!step || !run) return false;
  const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
  const stepDef = def?.steps[step.stepId];
  if (stepDef?.type === "agent") return isCodeStep(stepDef);
  return stepDef?.type === "fanout" && isCodeStep(stepDef.each);
}

/** True when the local branch exists. F1: --quiet makes a missing ref exit 1
 *  (locale-independent). Only exit 1 means absent; every other non-zero (incl.
 *  128 / timeout) stays unavailable. */
async function localBranchExists(ctx: Ctx, top: string, branch: string): Promise<boolean> {
  const found = await ctx.run(
    ["git", "-C", top, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    5_000,
    { env: { ...ctx.env, LC_ALL: "C", LANG: "C" } },
  );
  if (found.code === 0) return true;
  if (found.code === 1) return false;
  throw new CoreError(
    "unavailable",
    `cannot resolve task branch ${branch}: ${cleanLine(found.stderr) || `exit ${found.code}`}`,
  );
}

/** The task's own checkout on this machine (never the repository's), if it still exists. */
async function localTaskWorktree(ctx: Ctx, top: string, task: TaskRecord): Promise<string | undefined> {
  for (const path of [task.worktree, task.result?.worktree]) {
    if (!path || !existsSync(path)) continue;
    const info = await gitInfo(ctx.run, path);
    if ("error" in info) {
      // A directory git cannot read may still hold work: let the status check refuse it.
      return path;
    }
    if (realpathSafe(info.top) !== realpathSafe(top)) return path;
  }
  return undefined;
}

/**
 * The local branch holding a task's work and the commit it started from: its own
 * `pacer/<id>`, else the branch of the task whose worktree a retry reused, else
 * (code steps on backends that name branches themselves) the worktree's branch.
 */
async function taskWorkBranch(
  ctx: Ctx, top: string, task: TaskRecord, runBranch: string, code: boolean,
): Promise<{ branch: string; baseSha?: string } | null> {
  const own = `pacer/${task.id}`;
  if (await localBranchExists(ctx, top, own)) return { branch: own, baseSha: task.baseSha };
  const paths = [task.worktree, task.result?.worktree];
  const seen = new Set<string>([task.id]);
  for (let id = task.retryOf; id && !seen.has(id);) {
    seen.add(id);
    const prior = readTask(ctx, id);
    if (!prior) break;
    if (paths.some(path => path?.includes(`/${id}`)) && await localBranchExists(ctx, top, `pacer/${id}`)) {
      return { branch: `pacer/${id}`, baseSha: prior.baseSha };
    }
    id = prior.retryOf;
  }
  if (!code) return null;
  const worktree = await localTaskWorktree(ctx, top, task);
  if (!worktree) return null;
  const head = await ctx.run(["git", "-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"], 10_000);
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch || branch === runBranch) return null;
  return { branch, baseSha: task.baseSha };
}

/**
 * A code step's work must be committed on the branch that is about to be merged:
 * refuses uncommitted or untracked files, commits left on another branch or a
 * detached HEAD, and work still on a remote host. Nothing is dropped silently.
 */
async function assertCodeWorkCommitted(
  ctx: Ctx, top: string, task: TaskRecord, runBranch: string, tip: string | undefined,
): Promise<void> {
  const worktree = await localTaskWorktree(ctx, top, task);
  const expected = tip ?? `pacer/${task.id}`;
  if (worktree) {
    const dirty = await worktreeDirty(ctx, worktree);
    if (dirty === null) throw new CoreError("unavailable", "cannot read the task worktree status");
    if (dirty) {
      throw new CoreError(
        "invalid_input",
        `uncommitted changes in the task worktree: commit them on ${expected} (or remove stray files), then accept again`,
      );
    }
    const held = await ctx.run(
      ["git", "-C", worktree, "merge-base", "--is-ancestor", "HEAD", `refs/heads/${tip ?? runBranch}`],
      10_000,
    );
    if (held.code === 1) {
      throw new CoreError(
        "invalid_input",
        `the task worktree has commits that are not on ${expected}: move them there, then accept again`,
      );
    }
    if (held.code !== 0) {
      throw new CoreError("unavailable", `cannot compare the task worktree: ${cleanLine(held.stderr) || `exit ${held.code}`}`);
    }
  }
  if (!tip && task.run?.host) {
    throw new CoreError(
      "invalid_input",
      `the work of this task is not in the local repository (host ${task.run.host}): bring ${expected} here, then accept again`,
    );
  }
}

/** Commits on `branch` since the task started; null when git cannot count them. */
async function commitsAhead(ctx: Ctx, top: string, runBranch: string, work: { branch: string; baseSha?: string }): Promise<number | null> {
  // Ahead of the task's own base (not the run tip) so a moved base alone is not "ahead" (R2-F4).
  // Workflow step tasks keep their original baseSha across ask/answer (preserveBase), so
  // baseSha..task is the real work; fall back to run..task only when baseSha is absent.
  const range = work.baseSha ? `${work.baseSha}..${work.branch}` : `${runBranch}..${work.branch}`;
  const ahead = await ctx.run(["git", "-C", top, "rev-list", "--count", range], 10_000);
  return ahead.code === 0 ? Number(ahead.stdout.trim()) : null;
}

/**
 * Whether an accepted step task's work is on the run branch (or it has none).
 * False when it is not, or git cannot tell.
 */
export async function taskWorkMerged(ctx: Ctx, taskId: string): Promise<boolean> {
  const step = stepByTaskLineage(ctx, taskId);
  const stepRun = step ? getRun(ctx, step.runId) : null;
  const run = stepRun ? branchOwner(ctx, stepRun) : null;
  const task = readTask(ctx, taskId);
  if (!run?.branch || !task) return true;
  const top = await resolveRepoTop(ctx, run.repo);
  const work = await taskWorkBranch(ctx, top, task, run.branch, isCodeTask(ctx, taskId));
  if (!work) return true;
  if (await isAncestorOfRun(ctx, top, work.branch, run.branch)) return true;
  return await commitsAhead(ctx, top, run.branch, work) === 0;
}

/** What a reviewer of a step task compares: the branch holding its work, the
 *  commit it started from and the run branch an accept would merge it into. */
export type ReviewRef = { branch: string; base: string | null; runBranch: string };

export async function reviewRef(ctx: Ctx, taskId: string): Promise<ReviewRef | null> {
  const step = stepByTaskLineage(ctx, taskId);
  const stepRun = step ? getRun(ctx, step.runId) : null;
  const run = stepRun ? branchOwner(ctx, stepRun) : null;
  const task = readTask(ctx, taskId);
  if (!run?.branch || !task) return null;
  try {
    const top = await resolveRepoTop(ctx, run.repo);
    const work = await taskWorkBranch(ctx, top, task, run.branch, isCodeTask(ctx, taskId));
    return {
      branch: work?.branch ?? `pacer/${task.id}`,
      base: work?.baseSha ?? task.baseSha ?? null,
      runBranch: run.branch,
    };
  } catch {
    return null;
  }
}

/** Hands one ended child's own branch to `ownerId`, under the owner's merge lock. */
function adoptBranch(ctx: Ctx, ownerId: string, childId: string): Promise<boolean> {
  return withMergeLock(ctx, ownerId, async () => {
    const owner = getRun(ctx, ownerId), child = getRun(ctx, childId);
    if (!owner || !child?.branch || !child.baseRef || !child.baseSha) return true;
    const top = await resolveRepoTop(ctx, child.repo);
    if (await localBranchExists(ctx, top, child.branch)) {
      if (owner.branch && owner.branch !== child.branch && !await isAncestorOfRun(ctx, top, child.branch, owner.branch)) {
        const merged = await mergeIntoRunBranch(
          ctx, owner, top, child.branch, `Adopt ${child.branch} into ${owner.branch}`,
        );
        if (!merged.ok) {
          createConflictResolutionTask(ctx, owner, { id: `child:${child.id}`, rev: 0 }, child.branch, merged.files);
          return false;
        }
        await clearResolvedConflicts(ctx, owner, top, `child:${child.id}`);
      }
      // Its integration worktree holds the branch checked out: the owner needs it.
      const held = integrationPath(ctx, top, child.id);
      if (existsSync(held)) {
        const removed = await removeTaskWorktree(ctx, top, held, { force: true });
        if ("error" in removed) throw new CoreError("unavailable", cleanLine(removed.error));
      }
      if (!owner.branch) {
        setRunBranch(ctx, owner.id, { branch: child.branch, base_ref: child.baseRef, base_sha: child.baseSha });
      }
      for (const entry of child.conflict ?? []) setRunConflict(ctx, owner.id, entry);
    }
    clearRunBranch(ctx, child.id);
    clearRunConflict(ctx, child.id);
    return true;
  });
}

/**
 * Moves the branches that ended generated children of `parent` still own (runs
 * started before a generated child shared its parent's branch) to the owner,
 * keeping their merged work. False while one of them does not merge.
 */
export async function adoptGeneratedBranches(ctx: Ctx, parent: RunRow): Promise<boolean> {
  let all = true;
  for (const child of generatedChildren(ctx, parent)) {
    if (!child.branch || !RUN_TERMINAL.includes(child.status)) continue;
    const owner = branchOwner(ctx, parent);
    if (RUN_TERMINAL.includes(owner.status)) continue;
    try {
      if (!await adoptBranch(ctx, owner.id, child.id)) all = false;
    } catch (error) {
      console.warn(`pacer: run ${child.id} branch is not on run ${owner.id} yet: ${error instanceof Error ? error.message : String(error)}`);
      all = false;
    }
  }
  return all;
}

/** `--no-ff` merge of `source` into the run branch; a conflict is aborted and
 *  reported with its files. Call under the run's merge lock. */
async function mergeIntoRunBranch(
  ctx: Ctx, run: RunRow, top: string, source: string, message: string,
): Promise<{ ok: true } | { ok: false; files: string }> {
  const wt = await integrationWorktreeUnlocked(ctx, run);
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
    "-m", message,
    source,
  ];
  const merged = await ctx.run(argv, 60_000, { env: gitQuietEnv(ctx) });
  if (merged.code === 0) return { ok: true };
  const conflicted = /CONFLICT/i.test(merged.stdout + merged.stderr)
    || (await ctx.run(["git", "-C", wt, "rev-parse", "--verify", "MERGE_HEAD"], 5_000)).code === 0;
  if (!conflicted) {
    throw new CoreError("unavailable", `merge failed: ${cleanLine(merged.stderr) || cleanLine(merged.stdout) || `exit ${merged.code}`}`);
  }
  const files = (await ctx.run(["git", "-C", wt, "diff", "--name-only", "--diff-filter=U"], 15_000)).stdout.trim();
  await ctx.run(["git", "-C", wt, "merge", "--abort"], 30_000);
  return { ok: false, files };
}

/**
 * When `taskId` belongs to a run that has a branch, merge its work branch into the
 * run branch under the merge lock. Returns null when the task is not a run-branch
 * task (ordinary accept path). On conflict: aborts, creates a resolution task, no verdict.
 */
export async function mergeTaskOnAccept(ctx: Ctx, taskId: string): Promise<AcceptMergeResult | null> {
  const step = stepByTaskLineage(ctx, taskId);
  const stepRun = step ? getRun(ctx, step.runId) : null;
  let run = stepRun ? branchOwner(ctx, stepRun) : null;
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
  if (RUN_TERMINAL.includes(run.status)) {
    return { merged: true };
  }
  const task = readTask(ctx, taskId);
  if (!task) return null;
  const code = isCodeTask(ctx, taskId);

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (RUN_TERMINAL.includes(live.status)) {
      return { merged: true };
    }
    const top = await resolveRepoTop(ctx, live.repo);
    const work = await taskWorkBranch(ctx, top, task, live.branch!, code);
    // Before any shortcut: a code step with uncommitted work is never accepted.
    if (code) await assertCodeWorkCommitted(ctx, top, task, live.branch!, work?.branch);
    if (!work) {
      // Research / current-placement / cleaned worktree / resolution with no branch:
      // accept the verdict but only clear markers whose conflicting branch is already in.
      // Dirty check is skipped: there is nothing to merge (R2-F8).
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }
    const taskBranch = work.branch;

    // A failed rev-list is not treated as zero-ahead (pre-fallback behavior).
    if (await commitsAhead(ctx, top, live.branch!, work) === 0) {
      // M7: a non-code step with untracked notes and no commit is a plain accept.
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }

    // Non-code steps are checked only when there is something to merge (R2-F8/M7).
    const worktree = task.worktree ?? task.result?.worktree;
    if (!code && worktree) {
      const dirty = await worktreeDirty(ctx, worktree);
      if (dirty === true) {
        throw new CoreError("invalid_input", "uncommitted changes in the task worktree");
      }
    }

    const merged = await mergeIntoRunBranch(ctx, live, top, taskBranch, `Accept ${taskId} into ${live.branch}`);
    if (merged.ok) {
      await clearResolvedConflicts(ctx, live, top, taskId);
      return { merged: true };
    }
    const resolution = createConflictResolutionTask(ctx, live, task, taskBranch, merged.files);
    return { merged: false, merge: "conflict", resolution_task: resolution.id };
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
  const ofTask = !/^(base|child):/.test(task.id);
  const goal = (own: string) => [
    `Manual conflict resolution record for run ${run.id} (person or orchestrator; no executor runs this task).`,
    `Run branch: ${run.branch}. Conflicting branch: ${taskBranch}.`,
    dataPreamble(nonce),
    `--- data ${nonce} conflicting-paths ---`,
    capped,
    `--- end data ${nonce} ---`,
    ofTask
      ? `Resolve it on task ${task.id}: send it back (pacer review ${task.id} --send-back --note "merge ${run.branch} into your branch, resolve and commit"), or merge ${run.branch} into ${taskBranch} in its worktree and commit; then accept ${task.id}. This record closes by itself.`
      : `Resolve it by hand: git worktree add <dir> -b pacer/${own} ${run.branch}, merge ${taskBranch} there, resolve and commit, then run: pacer review ${own} --accept.`,
  ].join("\n");
  const resolution = createTask(ctx, {
    brief: { goal: goal("<this task>"), repo: run.repo, base: run.branch },
    kind: "debug",
    requestedExecutor: null,
    timeoutS: 3600,
    title: `Conflict · ${task.id}`.slice(0, 60),
    requestId,
  });
  // A record, not work: needs_input so the 600s never-started sweep cannot mark it
  // failed, and no question, since nothing could answer it.
  updateTask(ctx, resolution.id, t => {
    t.state = "needs_input";
    t.brief = { ...t.brief, goal: goal(resolution.id) };
  });
  setRunConflict(ctx, run.id, {
    taskId: task.id,
    branch: taskBranch,
    resolutionTaskId: resolution.id,
  });

  // Wake the orchestrator: on the parked step's review when it waits for one (it
  // can send the task back), else on the conflicting step or the run.
  const owning = stepByTask(ctx, task.id);
  if (run.orchestratorTaskId || run.planner) {
    try {
      enqueueWakeup(ctx, {
        runId: run.id,
        cause: owning && awaitsReview(ctx, owning) ? "review_due" : "step_failed",
        ref: owning
          ? stepWakeRef(owning.runId, owning.stepId, owning.attempt, owning.branch)
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
  const step = stepByTaskLineage(ctx, taskId);
  const run = step ? getRun(ctx, step.runId) : null;
  return run ? branchOwner(ctx, run).branch ?? null : null;
}

export type SyncBaseResult =
  | { ok: true; run: RunRow }
  | { ok: false; merge: "conflict"; resolution_task: string; run: RunRow };

/**
 * Merge the base branch's current tip into the run branch (same conflict path as accept).
 * Library form of `run.sync_base`; the op arrives in a later task.
 */
export async function syncBase(ctx: Ctx, runId: string, expectRev: number): Promise<SyncBaseResult> {
  const asked = getRun(ctx, runId);
  if (!asked) throw new CoreError("not_found", `unknown run ${runId}`);
  if (asked.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  const run = branchOwner(ctx, asked);
  const rev = run.rev;
  if (!run.branch || !run.baseRef) throw new CoreError("invalid_input", `run ${runId} has no branch to sync`);

  return withMergeLock(ctx, run.id, async () => {
    const live = getRun(ctx, run.id) ?? run;
    if (live.rev !== rev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
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
