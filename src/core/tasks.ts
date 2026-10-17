import { resolveRepo } from "./repos";
import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { repoKey } from "../config/hosts";
import { SCRIPTS } from "../remote/scripts";
import { runRemote } from "../remote/ssh";
import { transferred } from "../remote/transfer";
import { realpathSafe } from "./git";
import { removeTaskWorktree, taskWorktreePath, taskWorktreesDir, worktreeDirty } from "../supervisor/worktree";
import { readRun } from "../supervisor/run";
import { TERMINAL_STATES } from "../tasks/types";

import type { Strategy } from "../config/strategy";
import {
  type DelegateInput, type SpawnRunner, delegate as apiDelegate, spawnRunner, taskDismiss, taskReview, taskStatus,
  taskStop, taskWait,
} from "../tasks/api";
import { isTaskId, listTasks, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import { withLock } from "./lock";

export const WAIT_MIN_S = 1;
export const WAIT_MAX_S = 3000;

const unknown = (id: string) => new CoreError("unknown_task", `unknown task ${id}`);

export function get(ctx: Ctx, id: string): TaskRecord {
  const t = taskStatus(ctx, id);
  if (!t) throw unknown(id);
  return t;
}

/** Newest first; each task's liveness is re-checked like `get`. */
export function list(ctx: Ctx, o: { limit?: number } = {}): TaskRecord[] {
  return listTasks(ctx, o.limit ?? 20).map((t) => taskStatus(ctx, t.id) ?? t);
}

export function delegate(ctx: Ctx, input: DelegateInput, spawn: SpawnRunner = spawnRunner, s?: Strategy): TaskRecord {
  try {
    return s ? apiDelegate(ctx, input, spawn, s) : apiDelegate(ctx, input, spawn);
  } catch (e) {
    throw toCoreError(e);
  }
}

export async function wait(ctx: Ctx, id: string, timeoutS: number): Promise<TaskRecord> {
  if (!Number.isInteger(timeoutS) || timeoutS < WAIT_MIN_S || timeoutS > WAIT_MAX_S) {
    throw new CoreError("invalid_input", `timeout must be between ${WAIT_MIN_S} and ${WAIT_MAX_S} seconds`);
  }
  const t = await taskWait(ctx, id, timeoutS);
  if (!t) throw unknown(id);
  return t;
}

export function stop(ctx: Ctx, id: string): TaskRecord {
  const t = taskStop(ctx, id);
  if (!t) throw unknown(id);
  return t;
}

export function review(ctx: Ctx, id: string, v: { accepted: boolean; kind?: string; note?: string }): { recorded: true } {
  try {
    return taskReview(ctx, id, v.accepted, v.kind, v.note);
  } catch (e) {
    throw toCoreError(e);
  }
}

/** Dismisses every known id; unknown ids are returned, never thrown, so one bad id can't stop the rest. */
export function dismiss(ctx: Ctx, ids: string[]): { dismissed: TaskRecord[]; unknown: string[] } {
  const dismissed: TaskRecord[] = [], missing: string[] = [];
  for (const id of ids) {
    const t = taskDismiss(ctx, id);
    if (t) dismissed.push(t); else missing.push(id);
  }
  return { dismissed, unknown: missing };
}

function readFrom(file: string | undefined, offset: number): { text: string; next: number } {
  if (!file) return { text: "", next: offset };
  let fd: number;
  try { fd = openSync(file, "r"); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { text: "", next: offset };
    throw e;
  }
  try {
    const bytes = Buffer.alloc(256 * 1024);
    const n = readSync(fd, bytes, 0, bytes.length, offset);
    // Offsets are bytes; a UTF-8 character split at a chunk boundary may be replaced.
    return { text: bytes.subarray(0, n).toString("utf8"), next: offset + n };
  } finally { closeSync(fd); }
}

/** Reads output so far without refreshing liveness or restarting a task's runner. */
export function log(ctx: Ctx, id: string, o: { stdout?: number; stderr?: number } = {}): {
  stdout: string; stderr: string; next: { stdout: number; stderr: number }; done: boolean;
} {
  const task = readTask(ctx, id);
  if (!task) throw unknown(id);
  const stdout = o.stdout ?? 0, stderr = o.stderr ?? 0;
  if (![stdout, stderr].every((n) => Number.isInteger(n) && n >= 0)) throw new CoreError("invalid_input", "log offsets must be non-negative integers");
  const out = readFrom(task.run ? join(task.run.dir, "stdout") : task.attempts.at(-1)?.log, stdout);
  const err = task.run ? readFrom(join(task.run.dir, "stderr"), stderr) : { text: "", next: 0 };
  return {
    stdout: out.text, stderr: err.text, next: { stdout: out.next, stderr: err.next },
    done: TERMINAL_STATES.includes(task.state) || (task.run !== undefined && readRun(task.run.dir).exit !== null),
  };
}

/** Diff the task's worktree against its pacer base, or HEAD for existing checkouts. */
export async function diff(ctx: Ctx, id: string): Promise<{
  base: string | null; worktree: string; diff: string; untracked: string[]; truncated: boolean;
}> {
  const task = readTask(ctx, id);
  if (!task) throw unknown(id);
  const worktree = task.run?.workdir ?? task.worktree ?? task.result?.worktree ?? task.brief.repo;
  const base = task.run?.mode === "new" && task.baseBranch ? task.baseBranch : null;
  const git = async (args: string[]) => {
    const r = await ctx.run(["git", "-C", worktree, ...args], 10_000);
    if (r.code !== 0) throw new CoreError("invalid_input", `cannot diff: ${r.stderr.trim().split("\n")[0] || `git exited with code ${r.code}`}`);
    return r.stdout;
  };
  const output = await git(["diff", ...(base ? ["--merge-base"] : []), "--no-ext-diff", "--no-textconv", "--end-of-options", base ?? "HEAD", "--"]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  const bytes = Buffer.from(output, "utf8"), max = 1024 * 1024, truncated = bytes.length > max;
  // Keep the byte cap even when the cut falls inside a UTF-8 character.
  const text = truncated ? new TextDecoder().decode(bytes.subarray(0, max), { stream: true }) : output;
  return { base, worktree, diff: text, untracked, truncated };
}

/** Re-delegates a task's stored brief. One active retry per task: a second call gets `conflict`. */
export async function retry(
  ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean } = {},
  deps: { delegate?: (ctx: Ctx, input: DelegateInput) => TaskRecord } = {},
): Promise<{ retry: TaskRecord; of: TaskRecord }> {
  if (!isTaskId(id)) throw unknown(id);
  return withLock(ctx, `retry-${id}`, async () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    const prior = task.retriedBy ? readTask(ctx, task.retriedBy) : null;
    if (prior && ["queued", "running"].includes(prior.state)) {
      throw new CoreError("conflict", `${task.id} already has an active retry ${prior.id}`);
    }
    const input: DelegateInput = {
      brief: { ...task.brief }, repoRef: task.repo ?? await resolveRepo(ctx,task.brief.repo), kind: task.kind, timeoutMin: task.timeoutS / 60, retryOf: task.id,
      ...(task.placement?.requested === "current" || task.placement?.requested === "new" ? { worktree: task.placement.requested } : {}),
      ...(task.placement?.reason !== undefined ? { worktree_reason: task.placement.reason } : {}),
      ...(task.force ? { force: true } : {}),
      ...(o.executor ? { executor: o.executor } : {}),
    };
    let next: TaskRecord;
    try {
      next = (deps.delegate ?? ((c, i) => apiDelegate(c, i)))(ctx, input);
    } catch (e) {
      throw toCoreError(e);
    }
    if (readTask(ctx, next.id)) updateTask(ctx, next.id, (t) => { t.retryOf = task.id; if (o.fromPanel) t.fromPanel = true; });
    const of = updateTask(ctx, task.id, (t) => { t.retriedBy = next.id; });
    return { retry: readTask(ctx, next.id) ?? next, of };
  });
}

/** Removes settled, reviewed/dismissed/resolved task worktrees. Local branches stay. */
export async function clean(ctx: Ctx, o: { dryRun?: boolean; force?: boolean } = {}): Promise<{ removed: string[]; kept: { id: string; reason: string }[] }> {
  const removed: string[] = [], kept: { id: string; reason: string }[] = [], root = taskWorktreesDir(ctx) + "/";
  for (const t of listTasks(ctx, Infinity)) {
    if (!TERMINAL_STATES.includes(t.state) || !(t.review || t.dismissed || t.resolved) || t.run?.mode !== "new") continue;
    const top = realpathSafe(t.brief.repo);
    const wt = t.run.host ? taskWorktreePath(ctx, top, t.id) : t.run.workdir;
    if (!wt.startsWith(root) || (!t.run.host && !existsSync(wt))) continue;
    const path = join(root, ...wt.slice(root.length).split("/").slice(0, 2)); // worktree root: <root>/<repo-tag>/<task-id>
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
        const remote = await runRemote(ctx, host, SCRIPTS.CLEAN, [t.run.remoteWorktree, t.run.remoteDir, checkout, t.id, await transferred(ctx, t) ? (t.run.remoteBranch ?? `pacer/${t.id}`) : ""]);
        if (remote.code) { kept.push({ id: t.id, reason: remote.stderr.trim() || "remote cleanup failed" }); continue; }
      } catch (e) { kept.push({ id: t.id, reason: e instanceof Error ? e.message : String(e) }); continue; }
    }
    if (existsSync(path)) {
      const r = await removeTaskWorktree(ctx, top, path, { force: o.force });
      if ("error" in r) { kept.push({ id: t.id, reason: r.error }); continue; }
    }
    rmSync(join(ctx.pacerHome, "runs", t.id), { recursive: true, force: true });
    removed.push(t.id);
  }
  return { removed, kept };
}
