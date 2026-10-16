import { apiTask } from "../api/read-model/tasks";
import type { ApiTask } from "../api/read-model/types";
import { createHash } from "node:crypto";
import { repoFor, resolveRepo } from "./repos";
import { closeSync, existsSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendActivity, type ActivityEntry } from "../activity/log";
import { executorName, shortGoal } from "../link/notification";
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
import { isTaskId, listTasks, readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord, TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import { withLock, withLockSync } from "./lock";

function taskActivity(ctx: Ctx, task: TaskRecord, kind: ActivityEntry["kind"], text: string): void {
  const executor = task.result?.executor ?? task.executor ?? task.attempts.at(-1)?.executor ?? task.requestedExecutor;
  appendActivity(ctx, { kind, level: "info", text, repo: (task.repo ?? repoFor(ctx, task.brief.repo)).key, taskId: task.id,
    ...(executor ? { executor } : {}), ...(task.run?.host ? { host: task.run.host } : {}) });
}

export function checkRev(ctx: Ctx, t: TaskRecord, expect?: number): void {
  if (expect !== undefined && expect !== t.rev) {
    throw new CoreError("conflict", "task changed", undefined, { task: apiTask(ctx, t) });
  }
}

export const WAIT_MIN_S = 1;
export const WAIT_MAX_S = 3000;

const unknown = (id: string) => new CoreError("unknown_task", `unknown task ${id}`);

export function get(ctx: Ctx, id: string): TaskRecord {
  const t = taskStatus(ctx, id);
  if (!t) throw unknown(id);
  return t;
}

export interface ListOptions {
  limit?: number; before?: string; repo?: string; states?: TaskState[]; executor?: string; since?: number;
}

/** Newest first; filter before taking the page. */
export function list(ctx: Ctx, o: ListOptions = {}): TaskRecord[] {
  return listTasks(ctx, Infinity).filter(t => o.before === undefined || t.id < o.before)
    .map(t => taskStatus(ctx, t.id) ?? t)
    .filter(t => (o.repo === undefined || (t.repo ?? repoFor(ctx,t.brief.repo)).key === o.repo)
      && (o.states === undefined || o.states.includes(t.state))
      && (o.executor === undefined || (t.result?.executor ?? t.executor ?? t.attempts.at(-1)?.executor ?? t.requestedExecutor) === o.executor)
      && (o.since === undefined || t.createdAt >= o.since))
    .slice(0, o.limit ?? 20);
}

export function delegate(ctx: Ctx, input: DelegateInput, spawn: SpawnRunner = spawnRunner, s?: Strategy): TaskRecord {
  const create = () => {
    if (input.requestId) {
      const prior = listTasks(ctx, Infinity).find(t => t.requestId === input.requestId && ctx.now - t.createdAt >= 0 && ctx.now - t.createdAt <= 600);
      if (prior) return prior;
    }
    try {
      const task = s ? apiDelegate(ctx, input, spawn, s) : apiDelegate(ctx, input, spawn);
      if (!input.retryOf) taskActivity(ctx, task, "task_started", `Delegated “${shortGoal(task.brief.goal, 60)}” to ${executorName(task.executor ?? task.requestedExecutor)}`);
      return task;
    } catch (e) { throw toCoreError(e); }
  };
  // Delegate is synchronous for CLI/retry callers. This shares withLock's files;
  // hashing keeps arbitrary client request ids out of filesystem paths.
  return input.requestId === undefined ? create() : withLockSync(ctx, `delegate-request-${createHash("sha256").update(input.requestId).digest("hex")}`, create);
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
  const before = readTask(ctx, id);
  const t = taskStop(ctx, id);
  if (!t) throw unknown(id);
  if (before && !TERMINAL_STATES.includes(before.state)) taskActivity(ctx, t, "task_settled", `Stopped “${shortGoal(t.brief.goal, 60)}”`);
  return t;
}

export type ReviewVerdict = "accept" | "reject" | "send_back" | "retry";
export interface ReviewOptions {
  verdict?: ReviewVerdict;
  accepted?: boolean;
  executor?: string;
  kind?: string;
  note?: string;
  expect_state?: TaskState;
}
type RetryDeps = { delegate?: (ctx: Ctx, input: DelegateInput) => TaskRecord };

export async function review(
  ctx: Ctx, id: string, v: ReviewOptions, deps: RetryDeps = {},
): Promise<{ task: ApiTask; retry?: ApiTask }> {
  // Record synchronously while taskMutation's revision lock is still held.
  const { task, verdict, executor } = withTaskLock(ctx, id, () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    const verdict = v.verdict ?? (v.accepted === undefined ? undefined : v.accepted ? "accept" : "reject");
    if (!verdict || !["accept", "reject", "send_back", "retry"].includes(verdict)) {
      throw new CoreError("invalid_input", "give a verdict or accepted");
    }
    if (verdict === "send_back" && !v.note?.trim()) throw new CoreError("invalid_input", "send_back requires a note");
    if (verdict === "retry" && !v.executor?.trim()) throw new CoreError("invalid_input", "retry requires an executor");
    if (!TERMINAL_STATES.includes(task.state) || (v.expect_state !== undefined && v.expect_state !== task.state)) {
      throw new CoreError("conflict", "task state changed", undefined, { task: apiTask(ctx, task) });
    }
    const executor = verdict === "send_back" ? task.result?.executor ?? task.attempts.at(-1)?.executor ?? task.requestedExecutor ?? undefined : v.executor;
    if (verdict === "send_back" && !executor) throw new CoreError("invalid_input", "task has no executor to send back to");
    try {
      taskReview(ctx, id, verdict === "accept", v.kind, v.note);
      const reviewed = readTask(ctx, id)!, goal = shortGoal(reviewed.brief.goal, 60);
      taskActivity(ctx, reviewed, "verdict", verdict === "accept" ? `Accepted “${goal}”` : verdict === "send_back" ? `Sent “${goal}” back to ${executorName(executor)}` : `Rejected “${goal}”`);
    } catch (e) {
      throw toCoreError(e);
    }
    return { task: readTask(ctx, id)!, verdict, executor };
  });
  if (verdict === "send_back" || verdict === "retry") {
    const result = await retry(ctx, id, { executor, ...(verdict === "send_back" ? { feedback: v.note } : {}) }, deps);
    return { task: apiTask(ctx, result.of), retry: apiTask(ctx, result.retry) };
  }
  return { task: apiTask(ctx, task) };
}

/** Dismisses every known id; unknown ids are returned, never thrown, so one bad id can't stop the rest. */
export function dismiss(ctx: Ctx, ids: string[]): { dismissed: TaskRecord[]; unknown: string[] } {
  const dismissed: TaskRecord[] = [], missing: string[] = [];
  for (const id of ids) {
    const t = taskDismiss(ctx, id);
    if (t) {
      dismissed.push(t);
      taskActivity(ctx, t, "verdict", `Dismissed “${shortGoal(t.brief.goal, 60)}”`);
    } else missing.push(id);
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

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
  binary: boolean;
}

/** Diff the task's worktree against its pacer base, or HEAD for existing checkouts. */
export async function diff(ctx: Ctx, id: string, o: { path?: string } = {}): Promise<{
  base: string | null; worktree: string; files: DiffFile[]; patch: string; diff: string;
  untracked: string[]; truncated: boolean; note?: string;
}> {
  const task = readTask(ctx, id);
  if (!task) throw unknown(id);
  const reviewWorktree = task.result?.worktree?.startsWith(`${task.run?.host}:`) ? undefined : task.result?.worktree;
  const worktree = task.run?.host
    ? reviewWorktree ?? task.brief.repo
    : task.run?.workdir ?? task.worktree ?? task.result?.worktree ?? task.brief.repo;
  const base = task.run?.mode === "new" && task.baseBranch ? task.baseBranch : null;
  if (task.run?.host && (!reviewWorktree || task.state === "running")) {
    return { base, worktree, files: [], patch: "", diff: "", untracked: [], truncated: false, note: `changes are on ${task.run.host} until the run ends` };
  }
  const git = async (args: string[]) => {
    const r = await ctx.run(["git", "--literal-pathspecs", "-C", worktree, ...args], 10_000);
    if (r.code !== 0) throw new CoreError("invalid_input", `cannot diff: ${r.stderr.trim().split("\n")[0] || `git exited with code ${r.code}`}`);
    return r.stdout;
  };
  const args = ["diff", ...(base ? ["--merge-base"] : []), "--no-ext-diff", "--no-textconv", "-M"];
  const against = ["--end-of-options", base ?? "HEAD", "--"];
  const names = (await git([...args, "--name-status", "-z", ...against])).split("\0");
  const statuses = new Map<string, DiffFile["status"]>();
  const renamedFrom = new Map<string, string>();
  for (let i = 0; i < names.length && names[i];) {
    const status = names[i++];
    let path = names[i++];
    if (status.startsWith("R") || status.startsWith("C")) {
      const source = path;
      path = names[i++];
      renamedFrom.set(path, source);
    }
    statuses.set(path, status.startsWith("R") ? "renamed" : status === "A" || status.startsWith("C") ? "added" : status === "D" ? "deleted" : "modified");
  }
  const stats = (await git([...args, "--numstat", "-z", ...against])).split("\0");
  const files: DiffFile[] = [];
  for (let i = 0; i < stats.length && stats[i];) {
    const entry = stats[i++];
    const first = entry.indexOf("\t"), second = entry.indexOf("\t", first + 1);
    const added = entry.slice(0, first), removed = entry.slice(first + 1, second);
    let path = entry.slice(second + 1);
    if (!path) { i++; path = stats[i++]; } // -z encodes a rename as old NUL new NUL.
    files.push({ path, status: statuses.get(path) ?? "modified", added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed), binary: added === "-" || removed === "-" });
  }
  const paths = o.path === undefined ? [] : [...new Set([renamedFrom.get(o.path), o.path].filter((p): p is string => p !== undefined))];
  const output = await git([...args, ...against, ...paths]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z", ...(o.path === undefined ? [] : ["--", o.path])])).split("\0").filter(Boolean);
  const bytes = Buffer.from(output, "utf8"), max = (o.path === undefined ? 1 : 4) * 1024 * 1024, truncated = bytes.length > max;
  // Keep the byte cap even when the cut falls inside a UTF-8 character.
  const patch = truncated ? new TextDecoder().decode(bytes.subarray(0, max), { stream: true }) : output;
  return { base, worktree, files, patch, diff: patch, untracked, truncated };
}

/** Re-delegates a task's stored brief. One active retry per task: a second call gets `conflict`. */
export async function retry(
  ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean; feedback?: string; expectRev?: number } = {},
  deps: RetryDeps = {},
): Promise<{ retry: TaskRecord; of: TaskRecord }> {
  if (!isTaskId(id)) throw unknown(id);
  // Resolve repo identity before taking the synchronous task lock (it runs git).
  const before = readTask(ctx, id);
  const repoRef = before ? before.repo ?? await resolveRepo(ctx, before.brief.repo) : undefined;
  return withLock(ctx, `retry-${id}`, async () => withTaskLock(ctx, id, () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    checkRev(ctx, task, o.expectRev);
    const prior = task.retriedBy ? readTask(ctx, task.retriedBy) : null;
    if (prior && ["queued", "running"].includes(prior.state)) {
      throw new CoreError("conflict", `${task.id} already has an active retry ${prior.id}`);
    }
    const input: DelegateInput = {
      source: task.source, brief: { ...task.brief, ...(o.feedback?.trim() ? { feedback: [task.brief.feedback, o.feedback].filter(Boolean).join("\n\n") } : {}) }, repoRef, kind: task.kind, timeoutMin: task.timeoutS / 60, retryOf: task.id,
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
    const retried = readTask(ctx, next.id) ?? next;
    taskActivity(ctx, retried, "retry", `Delegated “${shortGoal(retried.brief.goal, 60)}” to ${executorName(retried.executor ?? retried.requestedExecutor)}`);
    return { retry: retried, of };
  }));
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
