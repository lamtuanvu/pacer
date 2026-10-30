import { beginWorkSync, finishUnlaunchedWorkSync } from "../update/desktop/admission";
import { resolvePolicyRepo } from "./project-policy";
import { taskDiff } from "../tasks/diff";
import { taskTitle } from "./short-title";
import { apiTask } from "../api/read-model/tasks";
import type { ApiTask } from "../api/read-model/types";
import { createHash } from "node:crypto";
import { repoFor, requireRepoDirectory } from "./repos";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { executorName } from "../link/notification";
import { boundedGitRead } from "./git";
import { restoreTaskWorktree } from "../supervisor/worktree";
import { readRun } from "../supervisor/run";
import { TERMINAL_STATES } from "../tasks/types";

import type { Strategy } from "../config/strategy";
import {
  type DelegateInput, type SpawnRunner, delegate as apiDelegate, spawnRunner, taskDismiss, taskReview, taskStatus,
  taskStop, taskWait,
} from "../tasks/api";
import { isTaskId, listTasksWhere, readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord, TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { isExecutorSession } from "../install/role";
import { CoreError, toCoreError } from "./errors";
import { withLock, withLockSync } from "./lock";

export { taskActivity } from "../tasks/activity";
import { taskActivity } from "../tasks/activity";
import { autoCleanTask } from "../tasks/cleanup";

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
  all?: boolean; limit?: number; before?: string; repo?: string; states?: TaskState[]; executor?: string; since?: number;
}

/** Newest first; filter before taking the page. */
export function list(ctx: Ctx, o: ListOptions = {}): TaskRecord[] {
  // Active tasks may transition during the status refresh, even when the caller
  // requested settled states. Keep them in the SQL selection, then filter again.
  const states: TaskState[] | undefined = o.states ? [...new Set<TaskState>([...o.states, "queued", "running"])] : undefined;
  return listTasksWhere(ctx, { updatedSince: o.since, states, all: o.all })
    .filter(t => o.before === undefined || t.id < o.before)
    .map(t => taskStatus(ctx, t.id) ?? t)
    .filter(t => (o.repo === undefined || (t.repo ?? repoFor(ctx,t.brief.repo)).key === o.repo)
      && (o.states === undefined || o.states.includes(t.state))
      && (o.executor === undefined || (t.result?.executor ?? t.executor ?? t.attempts.at(-1)?.executor ?? t.requestedExecutor) === o.executor)
      && (o.since === undefined || t.createdAt >= o.since))
    .slice(0, o.limit ?? 20);
}

export function requireAskingExecutor(ctx: Ctx, id = ctx.env.PACER_TASK_ID): string {
  if (!isExecutorSession(ctx) || !ctx.env.PACER_TASK_ID || id !== ctx.env.PACER_TASK_ID) {
    throw new CoreError("not_allowed", "pacer ask works only inside a delegated task");
  }
  return id;
}

/** Record one question for the current attempt. Transport callers enforce executor identity. */
export async function ask(ctx: Ctx, id: string, text: string): Promise<TaskRecord> {
  if (!isTaskId(id)) throw unknown(id);
  if (typeof text !== "string" || text.length < 1 || text.length > 1000) {
    throw new CoreError("invalid_input", "question must contain 1–1000 characters");
  }
  return withLock(ctx, `ask-${id}`, async () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    if (task.question && task.question.answer === undefined) throw new CoreError("conflict", "already asked; stop and wait for the answer");
    if (task.state !== "running") throw new CoreError("conflict", "task is not running");
    return updateTask(ctx, id, t => { t.question = { text, at: ctx.now }; });
  });
}

export function delegate(ctx: Ctx, input: DelegateInput, spawn: SpawnRunner = spawnRunner, s?: Strategy): TaskRecord {
  const lease = input.admissionLease ?? beginWorkSync(ctx, { kind: "launch", id: "delegate", label: "Delegating task" });
  const create = () => {
    if (input.requestId) {
      const prior = listTasksWhere(ctx, { updatedSince: ctx.now - 600 }).find(t => t.requestId === input.requestId && ctx.now - t.createdAt >= 0 && ctx.now - t.createdAt <= 600);
      if (prior && (prior.brief.goal !== input.brief.goal || prior.brief.repo !== input.brief.repo)) {
        throw new CoreError("conflict", "request_id was already used for a different brief", "use a new request_id for a new task");
      }
      if (prior) return prior;
    }
    try {
      const admitted = { ...input, admissionLease: lease };
      const task = s ? apiDelegate(ctx, admitted, spawn, s) : apiDelegate(ctx, admitted, spawn);
      if (!input.retryOf) taskActivity(ctx, task, "task_started", `Delegated “${taskTitle(task)}” to ${executorName(task.executor ?? task.requestedExecutor)}`);
      return task;
    } catch (e) { throw toCoreError(e); }
  };
  // Delegate is synchronous for CLI/retry callers. This shares withLock's files;
  // hashing keeps arbitrary client request ids out of filesystem paths.
  try { return input.requestId === undefined ? create() : withLockSync(ctx, `delegate-request-${createHash("sha256").update(input.requestId).digest("hex")}`, create); }
  finally { finishUnlaunchedWorkSync(ctx, lease); }
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
  if (before && !TERMINAL_STATES.includes(before.state)) taskActivity(ctx, t, "task_settled", `Stopped “${taskTitle(t)}”`);
  return t;
}

/** Request a human decision without recording a quality verdict. */
export function requestReview(ctx: Ctx, id: string, input: { note: string; expect_rev?: number }): TaskRecord {
  if (typeof input.note !== "string" || !input.note.trim() || input.note.trim().length > 2000) {
    throw new CoreError("invalid_input", "review request needs a note of 1–2000 characters");
  }
  const note = input.note.trim();
  return withTaskLock(ctx, id, () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    checkRev(ctx, task, input.expect_rev);
    if (!["done", "partial"].includes(task.state) || task.review || task.resolved || task.dismissed || task.retriedBy) {
      throw new CoreError("conflict", "task no longer needs a review request", undefined, { task: apiTask(ctx, task) });
    }
    if (task.reviewRequest?.note === note) return task;
    return updateTask(ctx, id, t => { t.reviewRequest = { note, at: ctx.now }; });
  });
}

export type ReviewVerdict = "accept" | "reject" | "send_back" | "retry";
export interface ReviewOptions {
  verdict?: ReviewVerdict;
  accepted?: boolean;
  executor?: string;
  kind?: string;
  note?: string;
  expect_state?: TaskState;
  expectRev?: number;
}
type RetryDeps = { delegate?: (ctx: Ctx, input: DelegateInput) => TaskRecord };

export async function review(
  ctx: Ctx, id: string, v: ReviewOptions, deps: RetryDeps = {},
): Promise<{ task: ApiTask; retry?: ApiTask }> {
  const check = () => {
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
    return { verdict, executor };
  };
  const record = (verdict: ReviewVerdict, executor: string | undefined) => withTaskLock(ctx, id, () => {
    try {
      const current=readTask(ctx,id);
      if(!current)throw unknown(id);
      checkRev(ctx,current,v.expectRev);
      taskReview(ctx, id, verdict === "accept", v.kind, v.note);
      const reviewed = readTask(ctx, id)!, goal = taskTitle(reviewed);
      taskActivity(ctx, reviewed, "verdict", verdict === "accept" ? `Accepted “${goal}”` : verdict === "send_back" ? `Sent “${goal}” back to ${executorName(executor)}` : `Rejected “${goal}”`);
    } catch (e) {
      throw toCoreError(e);
    }
    return readTask(ctx, id)!;
  });
  const { verdict, executor } = withTaskLock(ctx, id, check);
  if (verdict === "send_back" || verdict === "retry") {
    // Start the retry first: a verdict is recorded only when its retry exists.
    const result = await retry(ctx, id, { executor, ...(verdict === "send_back" ? { feedback: v.note } : {}) }, deps);
    return { task: apiTask(ctx, record(verdict, executor)), retry: apiTask(ctx, readTask(ctx, result.retry.id) ?? result.retry) };
  }
  const task = record(verdict, executor);
  await autoCleanTask(ctx, id);
  return { task: apiTask(ctx, task) };
}

/** Dismisses every known id; unknown ids are returned, never thrown, so one bad id can't stop the rest. */
export async function dismiss(ctx: Ctx, ids: string[]): Promise<{ dismissed: TaskRecord[]; unknown: string[] }> {
  const dismissed: TaskRecord[] = [], missing: string[] = [];
  for (const id of ids) {
    const t = taskDismiss(ctx, id);
    if (t) {
      dismissed.push(t);
      taskActivity(ctx, t, "verdict", `Dismissed “${taskTitle(t)}”`);
    } else missing.push(id);
  }
  await Promise.all(dismissed.map(task => autoCleanTask(ctx, task.id)));
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
  stdout: string; stderr: string; next: { stdout: number; stderr: number }; done: boolean; source: string;
} {
  const task = readTask(ctx, id);
  if (!task) throw unknown(id);
  const stdout = o.stdout ?? 0, stderr = o.stderr ?? 0;
  if (![stdout, stderr].every((n) => Number.isInteger(n) && n >= 0)) throw new CoreError("invalid_input", "log offsets must be non-negative integers");
  const outFile = task.run ? join(task.run.dir, "stdout") : task.attempts.at(-1)?.log;
  const errFile = task.run ? join(task.run.dir, "stderr") : undefined;
  // An opaque identity lets readers detect rerouting without exposing file paths.
  const source = createHash("sha256").update(JSON.stringify([outFile ?? null, errFile ?? null])).digest("hex");
  const out = readFrom(outFile, stdout);
  const err = errFile ? readFrom(errFile, stderr) : { text: "", next: 0 };
  return {
    source, stdout: out.text, stderr: err.text, next: { stdout: out.next, stderr: err.next },
    done: TERMINAL_STATES.includes(task.state) || (task.run !== undefined && readRun(task.run.dir).exit !== null),
  };
}

export type { DiffFile } from "../tasks/diff";

/** Diff the checkout, falling back to the attempt's saved review evidence. */
export async function diff(ctx: Ctx, id: string, o: { path?: string; summaryOnly?: boolean } = {}) {
  const task = readTask(ctx, id);
  if (!task) throw unknown(id);
  return taskDiff(ctx, task, o);
}

/** Re-delegates a task's stored brief. One active retry per task: a second call gets `conflict`. */
async function retryTask(
  ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean; feedback?: string; expectRev?: number; answerText?: string } = {},
  deps: RetryDeps = {},
): Promise<{ retry: TaskRecord; of: TaskRecord }> {
  if (!isTaskId(id)) throw unknown(id);
  // Resolve repo identity before taking the synchronous task lock (it runs git).
  const before = readTask(ctx, id);
  const repoRef = before ? before.repo && !before.repo.identityUnverified ? before.repo : await resolvePolicyRepo(ctx, before.brief.repo) : undefined;
  if (before) await requireRepoDirectory(before.brief.repo);
  let answerBase: string | undefined, answerFromBase = false;
  if (o.answerText !== undefined && before?.state === "needs_input" && before.question && before.question.answer === undefined && !before.retriedBy) {
    const worktree = [before.result?.worktree, before.worktree, !before.run?.host ? before.run?.workdir : undefined].find(p => p && p.startsWith("/"));
    if (worktree) {
      const head = await boundedGitRead(ctx.run, ["git", "-C", worktree, "rev-parse", "--verify", "HEAD"], 10_000);
      if (head.code === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) answerBase = head.stdout.trim();
      else if (!before.run?.host && !existsSync(worktree)) throw new CoreError("conflict", "the asking executor's worktree is unavailable; restore it before answering");
      else throw new CoreError("invalid_input", "cannot read the asking executor's worktree head");
    } else if (before.baseSha && before.worktreeReleased) {
      // Pacer removed the lane's unused worktree and forgot its path: start from the commit it was created from.
      answerBase = before.baseSha; answerFromBase = true;
    }
  }
  const lease = beginWorkSync(ctx, { kind: "launch", id, label: `Retrying task ${id}` });
  try { return await withLock(ctx, `retry-${id}`, async () => {
    // Ancestors can own the checkout reused by this task. Serialize against their
    // cleaners too, until the new task's reference and retriedBy are persisted.
    const ids = new Set<string>();
    for (let t = readTask(ctx, id); t && !ids.has(t.id); t = t.retryOf ? readTask(ctx, t.retryOf) : null) ids.add(t.id);
    const locks = [...ids].sort();
    const locked = async (index: number): Promise<{retry: TaskRecord; of: TaskRecord}> => {
      if (index < locks.length) return withLock(ctx, `clean-${locks[index]}`, () => locked(index + 1));
      const current = readTask(ctx, id);
      if (current) checkRev(ctx, current, o.expectRev);
      let restored: string | undefined;
      let missingBranch = false;
      const recorded = o.answerText === undefined && current
        ? [current.result?.worktree, current.worktree, !current.run?.host ? current.run?.workdir : undefined].find(p => p?.startsWith("/")) : undefined;
      if (recorded && current && !current.run?.host && !existsSync(recorded)) {
        // A cleaned checkout's branch retains committed executor work.
        const owner = [...ids].map(key => readTask(ctx, key)).find(t => t && recorded.includes(`/${t.id}`)) ?? current;
        const result = await restoreTaskWorktree(ctx, current.brief.repo, recorded, owner.id);
        if ("error" in result) throw new CoreError("conflict", result.error);
        restored = result.path;
        missingBranch = result.missingBranch;
      }
      return withTaskLock(ctx, id, () => {
        const task = readTask(ctx, id);
        if (!task) throw unknown(id);
        checkRev(ctx, task, o.expectRev);
        const answering = o.answerText !== undefined;
        if (answering && (task.state !== "needs_input" || !task.question || task.question.answer !== undefined || task.retriedBy)) {
          throw new CoreError("conflict", "task is not waiting for an answer", undefined, {task: apiTask(ctx, task)});
        }
        const executor = answering ? task.result?.executor ?? task.executor ?? task.attempts.at(-1)?.executor ?? task.requestedExecutor : o.executor;
        if (answering && !executor) throw new CoreError("invalid_input", "task has no executor to answer on");
        const prior = task.retriedBy ? readTask(ctx, task.retriedBy) : null;
        if (prior && ["queued", "running"].includes(prior.state)) {
          throw new CoreError("conflict", `${task.id} already has an active retry ${prior.id}`);
        }
        // Restore retained branches above; a missing branch starts a fresh checkout.
        const reuseWorktree = missingBranch ? undefined : restored ?? (!answering ? [task.result?.worktree, task.worktree, !task.run?.host ? task.run?.workdir : undefined].find(p => p?.startsWith("/")) : undefined);
        const input: DelegateInput = {
          ...(reuseWorktree ? { reuseWorktree, baseBranch: task.baseBranch, baseSha: task.baseSha } : {}),
          admissionLease: lease, repoValidated: true, title: taskTitle(task), source: task.source, brief: { ...task.brief, ...(answerBase ? {base:answerBase} : {}), ...(answering ? {qa:[...(task.brief.qa ?? []),{q:task.question!.text,a:o.answerText!}]} : {}), ...(o.feedback?.trim() ? { feedback: [task.brief.feedback, o.feedback].filter(Boolean).join("\n\n") } : {}) }, repoRef, kind: task.kind, timeoutMin: task.timeoutS / 60, retryOf: task.id,
          ...(task.placement?.requested === "current" || task.placement?.requested === "new" ? { worktree: task.placement.requested } : {}),
          ...(missingBranch ? {worktree: "new" as const} : {}),
          ...(answering && (task.placement?.mode === "new" || task.run?.mode === "new") ? {worktree:"new" as const} : {}),
          ...(missingBranch ? {worktree_reason: "previous worktree and branch are gone; creating a new worktree"}
            : task.placement?.reason !== undefined ? {worktree_reason: task.placement.reason} : {}),
          ...(task.force ? { force: true } : {}),
          ...(executor ? { executor } : {}),
          ...(task.interactive ? { interactive: true } : {}),
          ...(task.group ? { group: task.group } : {}),
        };
        let next: TaskRecord;
        try {
          next = (deps.delegate ?? ((c, i) => apiDelegate(c, i)))(ctx, input);
        } catch (e) {
          throw toCoreError(e);
        }
        if (readTask(ctx, next.id)) updateTask(ctx, next.id, (t) => {
          t.retryOf = task.id;
          if (o.fromPanel) t.fromPanel = true;
          if (missingBranch) t.placement = {...t.placement, requested: t.placement?.requested ?? "new", why: "previous worktree and branch are gone; creating a new worktree"};
        });
        const of = updateTask(ctx, task.id, (t) => { t.retriedBy = next.id; if (answering) { t.question!.answer = o.answerText; t.question!.answeredAt = ctx.now; } });
        const retried = readTask(ctx, next.id) ?? next;
        taskActivity(ctx, retried, "retry", `Delegated “${taskTitle(retried)}” to ${executorName(retried.executor ?? retried.requestedExecutor)}`);
        if (answerFromBase) taskActivity(ctx, retried, "message", `The asking worktree was removed; the answer starts from the recorded base ${answerBase!.slice(0, 12)}`);
        return { retry: retried, of };
      });
    };
    return locked(0);
  }); } finally { finishUnlaunchedWorkSync(ctx, lease); }
}

/** Re-delegate a brief; serializes with answers on the same task. */
export function retry(ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean; feedback?: string; expectRev?: number } = {}, deps: RetryDeps = {}) {
  return retryTask(ctx, id, o, deps);
}

/** Answer exactly once, creating a retry on the executor that asked. */
export async function answer(ctx: Ctx, id: string, text: string, o: { expectRev?: number } = {}, deps: RetryDeps = {}): Promise<{task: ApiTask; retry: ApiTask}> {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", "executors cannot delegate onward");
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) throw new CoreError("invalid_input", "answer must contain 1–2000 characters");
  const r = await retryTask(ctx, id, {...o, answerText:text}, deps);
  return {task:apiTask(ctx,r.of),retry:apiTask(ctx,r.retry)};
}

export { clean, cleanTask, autoCleanTask, autoCleanSweep, cleanTestHooks, verifiedTaskWorktreeRoot } from "../tasks/cleanup";
