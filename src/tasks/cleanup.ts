import { randomBytes } from "node:crypto";
import { type BigIntStats, existsSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { repoFs, cachedPath, withTimeout } from "../core/path-probe";
import { validateExecution } from "../config/execution";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { transferred } from "../remote/transfer";
import { repoKey } from "../config/hosts";
import { issueConfiguredHostClean } from "../plugins/host-clean-issuer";
import { pluginRegistry } from "../plugins";
import { removeTaskWorktree, taskWorktreePath, taskWorktreesDir, worktreeDirty } from "../supervisor/worktree";
import { cleanSettledSessions } from "../session/retention";
import { cleanHostWorktree, reconcileHostWork } from "../exec/cleanup";
import { TERMINAL_STATES, type TaskRecord } from "./types";
import { listTasksWhere, readTask } from "./store";
import { withLock } from "../core/lock";
import { cleanTaskRuns } from "./diff";
import { taskActivity } from "./activity";
import type { Ctx } from "../types";

const NOT_OWN_WORKTREE = "worktree path is not this task's worktree; not deleted";
const WORKTREE_CHANGED = "worktree changed during cleanup; not deleted";

/** A directory checked by verifiedTaskWorktreeRoot, identified by device and inode. */
type DirId = { path: string; dev: bigint; ino: bigint };

/** This task's own worktree root, <worktrees>/<repo-tag>/<task-id>, or why the recorded path is not it.
 *  `real` is the same directory under the canonical worktrees root. The repo-tag and task directories may not
 *  be symlinks; folders above the worktrees folder may be (macOS /var → /private/var, a linked home) and are
 *  resolved. The worktrees folder itself may be a symlink (moved to another disk); `symlinkedRoot` reports it
 *  so the direct delete can refuse it. `ids` pins the three checked directories for unchangedDirs before that delete. */
export function verifiedTaskWorktreeRoot(ctx: Ctx, t: TaskRecord, wt: string): { path: string; real: string; exists: boolean; symlinkedRoot: boolean; ids: DirId[] } | { invalid: string } {
  const root = taskWorktreesDir(ctx);
  if (!wt.startsWith(root + "/")) return { invalid: NOT_OWN_WORKTREE };
  const parts = wt.slice(root.length + 1).split("/");
  if (parts.length < 2 || parts.some(p => p === "" || p === "." || p === "..") || parts[1] !== t.id || normalize(wt) !== wt) return { invalid: NOT_OWN_WORKTREE };
  const [tag, id] = parts as [string, string], path = join(root, tag, id);
  let rootSt: BigIntStats;
  try { rootSt = lstatSync(root, { bigint: true }); } catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return { path, real: path, exists: false, symlinkedRoot: false, ids: [] }; throw e; }
  const symlinkedRoot = rootSt.isSymbolicLink();
  if (symlinkedRoot) try { rootSt = statSync(root, { bigint: true }); } catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return { path, real: path, exists: false, symlinkedRoot, ids: [] }; throw e; }
  if (!rootSt.isDirectory()) return { invalid: "worktrees folder is not a directory; not deleted" };
  const canonical = realpathSync(root), tagDir = join(canonical, tag), real = join(tagDir, id);
  const ids: DirId[] = [{ path: canonical, dev: rootSt.dev, ino: rootSt.ino }];
  for (const dir of [tagDir, real]) {
    let st: BigIntStats;
    try { st = lstatSync(dir, { bigint: true }); } catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) return { path, real, exists: false, symlinkedRoot, ids: [] }; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory() || realpathSync(dir) !== dir) return { invalid: NOT_OWN_WORKTREE };
    ids.push({ path: dir, dev: st.dev, ino: st.ino });
  }
  return { path, real, exists: true, symlinkedRoot, ids };
}

/** True when `path` is still the same real directory as `d`, which verifiedTaskWorktreeRoot checked. */
function sameDir(path: string, d: DirId): boolean {
  try { const st = lstatSync(path, { bigint: true }); return !st.isSymbolicLink() && st.isDirectory() && st.dev === d.dev && st.ino === d.ino; }
  catch { return false; }
}

/** True when every directory is still the same real directory that verifiedTaskWorktreeRoot checked. */
function unchangedDirs(ids: DirId[]): boolean {
  return ids.every(d => sameDir(d.path, d));
}

/** Name prefix of a task worktree moved aside for deletion, directly inside the worktrees folder. */
const DELETE_PREFIX = ".pacer-delete-";

/** Renames the verified task directory to a fresh, never-reused name directly in the canonical worktrees root, then
 *  checks the renamed path is still that directory and the root is unchanged. Returns the renamed path, or null after
 *  moving it back when its original path is free (a failed check) or leaving it in place (anything else). */
function moveAside(ids: DirId[], id: string): string | null {
  const [root, , task] = ids as [DirId, DirId, DirId];
  const aside = join(root.path, `${DELETE_PREFIX}${id}-${randomBytes(8).toString("hex")}`);
  try { renameSync(task.path, aside); } catch { return null; }
  let real: string | null = null;
  try { real = realpathSync(aside); } catch { /* checked below */ }
  if (real === aside && sameDir(aside, task) && sameDir(root.path, root)) return aside;
  // Never overwrite: move it back only when nothing took the original path.
  try { lstatSync(task.path); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") try { renameSync(aside, task.path); } catch { /* left for the leftover report */ }
  }
  return null;
}

/** Folders moved aside by an earlier forced clean that stopped before deleting them, reported and never deleted. */
function leftoverDeletes(ctx: Ctx): { id: string; reason: string }[] {
  const root = taskWorktreesDir(ctx);
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter(n => n.startsWith(DELETE_PREFIX)).sort()
    .map(n => ({ id: n, reason: `unfinished forced cleanup; not deleted, remove ${join(root, n)} by hand` }));
}

/** Test seams: run after verification and before the forced delete's identity re-check, and before its rename. */
export const cleanTestHooks: { beforeRecheck?: (real: string) => void; beforeRename?: (real: string) => void } = {};

/** True when cleanTaskRuns would still remove something for this task. */
function hasDisposableRuns(ctx: Ctx, t: TaskRecord): boolean {
  const root = join(ctx.pacerHome, "runs", t.id);
  if (!existsSync(root)) return false;
  return readdirSync(root, { withFileTypes: true }).some(e => !e.isDirectory() || !existsSync(join(root, e.name, "diff.json"))
    || readdirSync(join(root, e.name)).some(name => name !== "diff.json"));
}

/** Prunes run files after the worktree is gone; a failure keeps the task so the next clean retries it. */
function pruneRuns(ctx: Ctx, t: TaskRecord): string | null {
  try { cleanTaskRuns(ctx, t); return null; }
  catch (e) { return `worktree deleted; run files could not be pruned: ${e instanceof Error ? e.message : String(e)}`; }
}

type CleanResult = { removed: string[]; kept: { id: string; reason: string }[] };
function cleanable(t: TaskRecord): boolean {
  return TERMINAL_STATES.includes(t.state) && (t.state !== "needs_input" || t.question?.answer !== undefined)
    && !(t.question && t.question.answer === undefined)
    && Boolean(t.review || t.dismissed || t.resolved);
}

/** Read every successor under the owner's clean lock. Retry takes this lock before linking a successor. */
function cleanableChain(ctx: Ctx, task: TaskRecord): boolean {
  const seen = new Set<string>();
  let current: TaskRecord | null = task;
  while (current) {
    if (seen.has(current.id) || !cleanable(current)) return false;
    seen.add(current.id);
    if (!current.retriedBy) return true;
    current = readTask(ctx, current.retriedBy);
  }
  return false;
}

/** A retry defers only to a verified ancestor owner; unrelated paths retain the ownership warning. */
function ancestorOwnsWorktree(ctx: Ctx, task: TaskRecord, wt: string): boolean {
  const seen = new Set<string>([task.id]);
  let id = task.retryOf;
  while (id && !seen.has(id)) {
    seen.add(id);
    const ancestor = readTask(ctx, id);
    if (!ancestor) return false;
    if (!("invalid" in verifiedTaskWorktreeRoot(ctx, ancestor, wt))) return true;
    id = ancestor.retryOf;
  }
  return false;
}

/** One task, using the same ownership and dirty checks as the manual sweep. */
export async function cleanTask(ctx: Ctx, id: string, o: { dryRun?: boolean; force?: boolean } = {}): Promise<CleanResult> {
  return withLock(ctx, `clean-${id}`, () => cleanTaskLocked(ctx, id, o));
}

/** Caller holds this task's clean lock, or all retry ancestors' locks in sorted order. */
async function cleanTaskLocked(ctx: Ctx, id: string, o: { dryRun?: boolean; force?: boolean } = {}): Promise<CleanResult> {
  const removed: string[] = [], kept: { id: string; reason: string }[] = [], root = taskWorktreesDir(ctx) + "/";
  const shared = (t: TaskRecord, path: string) => listTasksWhere(ctx).some(other => other.id !== t.id
    && [other.worktree, other.result?.worktree, other.run?.workdir, other.brief.repo].some(p => {
      if (!p) return false;
      const a = cachedPath(p).real, b = cachedPath(path).real;
      return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
    })
    && !cleanable(other));
  const current = readTask(ctx, id);
  for (const t of current && cleanableChain(ctx, current) ? [current] : []) {
    try {
      const host = await cleanHostWorktree(ctx, t, { dryRun: o.dryRun, force: o.force, shared: path => shared(t, path) });
      if (host && "kept" in host) { kept.push({ id: t.id, reason: host.kept }); continue; }
      if (host) {
        const failed = o.dryRun ? null : pruneRuns(ctx, t);
        if (failed) { kept.push({ id: t.id, reason: failed }); continue; }
        if ("removed" in host) removed.push(t.id);
        continue;
      }
      if (t.run?.mode !== "new") continue;
      const top = await withTimeout(() => repoFs.realpath(t.brief.repo)).catch(error => { if (["ENOENT","ENOTDIR"].includes(error.code)) return null; throw error; });
      if (top === null && t.run.host) { kept.push({ id: t.id, reason: "source repository is missing; remote cleanup needs it" }); continue; }
      const wt = t.run.host ? taskWorktreePath(ctx, top!, t.id) : t.run.workdir;
      if (!(wt + "/").startsWith(root)) continue;
      const own = verifiedTaskWorktreeRoot(ctx, t, wt);
      if ("invalid" in own) {
        if (own.invalid !== NOT_OWN_WORKTREE || !ancestorOwnsWorktree(ctx, t, wt)) kept.push({ id: t.id, reason: own.invalid });
        continue;
      }
      if (!t.run.host && !own.exists) {
        // The worktree is already gone, possibly by an earlier clean whose run-file pruning failed: retry that.
        if (!hasDisposableRuns(ctx, t)) continue;
        const failed = o.dryRun ? null : pruneRuns(ctx, t);
        if (failed) kept.push({ id: t.id, reason: failed }); else removed.push(t.id);
        continue;
      }
      if (!t.run.host && !await withTimeout(() => repoFs.access(wt)).then(() => true, error => { if (["ENOENT","ENOTDIR"].includes(error.code)) return false; throw error; })) continue;
      const path = own.path;
      if (shared(t, path)) { kept.push({ id: t.id, reason: "worktree is shared with an active or unreviewed task" }); continue; }
      if (top === null) {
        // Without the repository git cannot check or remove the worktree; --force deletes only this task's verified directory.
        if (!o.force) { kept.push({ id: t.id, reason: "source repository is missing; use --force to delete the worktree" }); continue; }
        if (own.symlinkedRoot) { kept.push({ id: t.id, reason: "worktrees folder is a symlink; not deleted" }); continue; }
        cleanTestHooks.beforeRecheck?.(own.real);
        if (!unchangedDirs(own.ids)) { kept.push({ id: t.id, reason: WORKTREE_CHANGED }); continue; }
        if (!o.dryRun) {
          cleanTestHooks.beforeRename?.(own.real);
          const aside = moveAside(own.ids, t.id);
          if (!aside) { kept.push({ id: t.id, reason: WORKTREE_CHANGED }); continue; }
          // Node has no handle-based recursive delete, so a window remains between moveAside's checks and this
          // rmSync: a same-user process that replaces the worktrees folder itself, or renames another directory
          // into the aside name, gets that directory deleted. Accepted for this path only; see .project/decisions.md.
          rmSync(aside, { recursive: true, force: true });
          const failed = pruneRuns(ctx, t);
          if (failed) { kept.push({ id: t.id, reason: failed }); continue; }
        }
        removed.push(t.id); continue;
      }
      if (existsSync(path) && !o.force && (await worktreeDirty(ctx, path)) !== false) { kept.push({ id: t.id, reason: "uncommitted changes; use --force" }); continue; }
      if (o.dryRun) { removed.push(t.id); continue; }
      if (t.run.host) {
        try {
          const host = loadStrategy(ctx).hosts[t.run.host];
          const origin = await ctx.run(["git", "-C", top, "remote", "get-url", "origin"], 10000);
          const key = repoKey(origin.stdout.trim()), checkout = key && host?.repos[key];
          if (!host || !checkout || !t.run.remoteWorktree || !t.run.remoteDir) {
            kept.push({ id: t.id, reason: "remote cleanup needs a configured host, checkout and run" }); continue;
          }
          const grant = await issueConfiguredHostClean(ctx, t.run.host, t.id, await transferred(ctx, t), { force: o.force });
          const remote = await pluginRegistry(ctx).cleanConfiguredHost(ctx, grant);
          if (remote.code) { kept.push({ id: t.id, reason: remote.stderr.trim() || "remote cleanup failed" }); continue; }
        } catch (e) { kept.push({ id: t.id, reason: e instanceof Error ? e.message : String(e) }); continue; }
      }
      if (existsSync(path)) {
        const r = await removeTaskWorktree(ctx, top, path, { force: o.force });
        if ("error" in r) { kept.push({ id: t.id, reason: r.error }); continue; }
      }
      const failed = pruneRuns(ctx, t);
      if (failed) { kept.push({ id: t.id, reason: failed }); continue; }
      removed.push(t.id);
    } catch (e) { kept.push({ id: t.id, reason: e instanceof Error ? e.message : String(e) }); }
  }
  return {removed, kept};
}

function autoCleanEnabled(ctx: Ctx): boolean {
  try { return validateExecution(loadStrategy(ctx).execution).autoClean !== false; }
  catch (error) {
    if (error instanceof MissingStrategyError) return true;
    throw error;
  }
}

/** Best effort: cleanup must never turn a recorded verdict into an error.
 * Retry ancestors may own the reused checkout. Lock them in retryTask's sorted order,
 * then re-read each record and its successors before attempting deletion. */
export async function autoCleanTask(ctx: Ctx, id: string): Promise<void> {
  try {
    if (!autoCleanEnabled(ctx)) return;
    const ids = new Set<string>();
    for (let task = readTask(ctx, id); task && !ids.has(task.id); task = task.retryOf ? readTask(ctx, task.retryOf) : null) ids.add(task.id);
    const locks = [...ids].sort();
    const locked = async (index: number): Promise<void> => {
      if (index < locks.length) return withLock(ctx, `clean-${locks[index]}`, () => locked(index + 1));
      for (const key of ids) {
        try {
          const task = readTask(ctx, key);
          if (!task || !cleanable(task) || (!task.run && !task.worktree && !task.result?.worktree)) continue;
          const result = await cleanTaskLocked(ctx, key);
          for (const kept of result.kept) {
            const current = readTask(ctx, key);
            if (current) taskActivity(ctx, current, "verdict", `Kept worktree: ${kept.reason}`);
          }
        } catch (error) { recordCleanupError(ctx, key, error); }
      }
    };
    await locked(0);
  } catch (error) { recordCleanupError(ctx, id, error); }
}

function recordCleanupError(ctx: Ctx, id: string, error: unknown): void {
  try {
    const task = readTask(ctx, id);
    if (task) taskActivity(ctx, task, "verdict", `Kept worktree: ${String(error)}`);
  } catch { /* State/activity may also be unavailable. Retry on the next sweep. */ }
}

/** Removes settled, reviewed/dismissed/resolved task worktrees. Local branches stay. */
export async function clean(ctx: Ctx, o: { dryRun?: boolean; force?: boolean } = {}): Promise<CleanResult> {
  const result: CleanResult = {removed: [], kept: []};
  if (!o.dryRun) await reconcileHostWork(ctx);
  for (const task of listTasksWhere(ctx, {states: TERMINAL_STATES})) {
    try {
      const one = await cleanTask(ctx, task.id, o);
      result.removed.push(...one.removed); result.kept.push(...one.kept);
    } catch (error) { result.kept.push({id: task.id, reason: String(error)}); }
  }
  result.kept.push(...leftoverDeletes(ctx));
  if (!o.dryRun) cleanSettledSessions(ctx);
  return result;
}

/** Service startup/hourly sweep; disabled together with lifecycle cleanup. */
export async function autoCleanSweep(ctx: Ctx): Promise<void> {
  if (!autoCleanEnabled(ctx)) return;
  await clean(ctx);
}
