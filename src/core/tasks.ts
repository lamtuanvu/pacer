import { beginWorkSync, finishUnlaunchedWorkSync, validatePendingWorkSync } from "../update/desktop/admission";
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
import { admissionLifetime } from "../tasks/creation-admission";
import { getWork,pendingChildren,requireWorkScope } from "../dispatch/work";
import { readProjectStrategies } from "../config/project-strategies";
import { loadStrategy,KINDS,MissingStrategyError } from "../config/strategy";
import { boundedGitRead } from "./git";
import { restoreTaskWorktree } from "../supervisor/worktree";
import { readRun } from "../supervisor/run";
import { TERMINAL_STATES } from "../tasks/types";

import type { Strategy } from "../config/strategy";
import {
  type DelegateInput, type SpawnRunner, admissionCtx, delegate as apiDelegate, spawnRunner, taskDismiss, taskReview, taskStatus,
  taskStop, taskWait,
} from "../tasks/api";
import { isTaskId, listTasksWhere, readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord, TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { isExecutorSession } from "../install/role";
import { CoreError, toCoreError } from "./errors";
import { withLock, withLockSync } from "./lock";
import { callerParticipant, parentOf, rootOf } from "../messaging/participants";
import * as msgStore from "../messaging/store";
import { beginTurn, notifyMessage, readMessages } from "../messaging/turns";

/** True when the next turn can resume the task's own native session; managed work restarts through its managed path. */
export function canContinue(_ctx: Ctx, t: TaskRecord): boolean {
  return t.interactionMode !== "conversation" && !!t.run && (!!t.run.agentSession || /opencode/.test(t.run.executor));
}

export { taskActivity } from "../tasks/activity";
import { taskActivity } from "../tasks/activity";
import { autoCleanTask } from "../tasks/cleanup";

/** A work root a person started. It keeps the usual task controls; managed children and planner roots use dispatch.*. */
export function userStartedRoot(ctx: Ctx, t: TaskRecord): boolean {
  const work = getWork(ctx, t.id);
  return !!work && !work.parentId && t.origin === "human";
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
    const asked = updateTask(ctx, id, t => { t.question = { text, at: ctx.now }; });
    const parent = parentOf(ctx, `task:${id}`);
    if (parent) {
      const r = msgStore.insertMessage(ctx, { taskId: id, rootId: rootOf(ctx, `task:${id}`), from: `task:${id}`, to: parent, kind: "question", body: text, replyTo: null, requestId: `ask:${id}:${ctx.now}` });
      if (!r.duplicate) void notifyMessage(ctx, r.message);
    }
    return asked;
  });
}

export async function delegate(ctx: Ctx, input: DelegateInput, spawn: SpawnRunner = spawnRunner, s?: Strategy): Promise<TaskRecord> {
  admissionCtx(ctx);
  const lease = input.admissionLease ?? beginWorkSync(ctx, { kind: "launch", id: "delegate", label: "Delegating task" });
  const create = async () => {
    const currentNow=admissionCtx(ctx).now;
    if (input.requestId) {
      const prior = listTasksWhere(ctx, { updatedSince: currentNow - 600 }).find(t => t.requestId === input.requestId && currentNow - t.createdAt >= 0 && currentNow - t.createdAt <= 600);
      if (prior && (prior.brief.goal !== input.brief.goal || prior.brief.repo !== input.brief.repo)) {
        throw new CoreError("conflict", "request_id was already used for a different brief", "use a new request_id for a new task");
      }
      if (prior) return prior;
    }
    try {
      const admitted = { ...input, admissionLease: lease };
      const task = await (s ? apiDelegate(ctx, admitted, spawn, s) : apiDelegate(ctx, admitted, spawn));
      if (!input.retryOf) taskActivity(ctx, task, "task_started", `Delegated “${taskTitle(task)}” to ${executorName(task.executor ?? task.requestedExecutor)}`);
      return task;
    } catch (e) { throw toCoreError(e); }
  };
  // Serialize same-key decisions without holding a synchronous commit lock.
  try { return await (input.requestId === undefined ? create() : withLock(ctx, `core-delegate-request-${createHash("sha256").update(input.requestId).digest("hex")}`, create)); }
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
type RetryDeps = { delegate?: (ctx: Ctx, input: DelegateInput) => TaskRecord | Promise<TaskRecord>; beforeCommit?:()=>void; afterCommit?:(parent:TaskRecord,retry:TaskRecord)=>void; spawnRunner?: SpawnRunner; appAuthenticated?: boolean; participant?: string };

/**
 * Deliver a follow-up (answer or review feedback) as a message that resumes the task's own session.
 * Returns null when no turn started; the message is then marked read so it never reaches a later turn,
 * and the caller falls back to the legacy retry.
 */
async function continueWithMessage(ctx: Ctx, task: TaskRecord, m: { kind: "answer" | "message"; body: string; replyTo: string | null; requestId: string }, deps: RetryDeps,
  before?: () => void, undo?: () => void): Promise<ApiTask | null> {
  const id = task.id, to = `task:${id}`;
  const from = callerParticipant(ctx, { appAuthenticated: deps.appAuthenticated, participant: deps.participant }).id;
  const r = msgStore.insertMessage(ctx, { taskId: id, rootId: rootOf(ctx, to), from, to, kind: m.kind, body: m.body, replyTo: m.replyTo, requestId: m.requestId });
  if (r.duplicate) return apiTask(ctx, readTask(ctx, id)!); // A retried request: the first one already acted.
  void notifyMessage(ctx, r.message);
  before?.();
  // A policy hold falls back to the legacy retry, which project policy admits as a new attempt (a veto refuses it there).
  if ((await beginTurn(ctx, id, deps.spawnRunner ?? spawnRunner, { quiet: true })).delivery === "turn_started") return apiTask(ctx, readTask(ctx, id)!);
  undo?.();
  msgStore.markRead(ctx, to, [r.message.id]);
  return null;
}

export async function review(
  ctx: Ctx, id: string, v: ReviewOptions, deps: RetryDeps = {},
): Promise<{ task: ApiTask; retry?: ApiTask }> {
  ctx={...ctx,env:{...ctx.env}};v={...v};
  const check = () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    checkRev(ctx,task,v.expectRev);
    if(v.kind!==undefined&&!(KINDS as readonly string[]).includes(v.kind))throw new CoreError("invalid_input",`unknown kind "${v.kind}"`);
    if(ctx.env.PACER_WORK_GRANT)requireWorkScope(admissionCtx(ctx),ctx.env.PACER_WORK_GRANT,id,true);
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
    return { verdict, executor, task };
  };
  const { verdict, executor, task:initialTask } = withTaskLock(ctx,id,check);
  const reviewLease=beginWorkSync(ctx,{kind:"operation",id,label:"Reviewing task"});
  try {
  const strategy=()=>{try{return loadStrategy(ctx);}catch(error){if(error instanceof MissingStrategyError)return null;throw error;}};
  const {applyPolicy}=await import("../plugins/policy");
  const authorization=await applyPolicy(admissionCtx(ctx),"review",{
    taskId:id,revision:initialTask.rev,state:initialTask.state,verdict,
    ...(v.note!==undefined?{note:v.note}:{}),kind:(v.kind??initialTask.kind) as typeof KINDS[number]|null,
    ...(executor?{executor}:{}),
  },{...admissionLifetime(ctx),contextFingerprint:()=>JSON.stringify({task:readTask(ctx,id),work:getWork(ctx,id),children:pendingChildren(ctx,id),strategy:strategy(),projects:readProjectStrategies(ctx)})});
  const validateReview=()=>{
    const task=readTask(ctx,id);if(!task)throw unknown(id);checkRev(ctx,task,initialTask.rev);
    authorization.revalidate();
    validatePendingWorkSync(admissionCtx(ctx),reviewLease);
    if(ctx.env.PACER_WORK_GRANT)requireWorkScope(admissionCtx(ctx),ctx.env.PACER_WORK_GRANT,id,true);
  };
  const record = (verdict: ReviewVerdict, executor: string | undefined, expected=initialTask.rev) => withTaskLock(ctx, id, () => {
    try {
      const current=readTask(ctx,id);
      if(!current)throw unknown(id);
      checkRev(ctx,current,expected);
      taskReview(ctx, id, verdict === "accept", v.kind, v.note);
      const reviewed = readTask(ctx, id)!, goal = taskTitle(reviewed);
      taskActivity(ctx, reviewed, "verdict", verdict === "accept" ? `Accepted “${goal}”` : verdict === "send_back" ? `Sent “${goal}” back to ${executorName(executor)}` : `Rejected “${goal}”`);
    } catch (e) {
      throw toCoreError(e);
    }
    return readTask(ctx, id)!;
  });
  if (verdict === "send_back" || verdict === "retry") {
    const current = readTask(ctx, id);
    if (verdict === "send_back" && current && canContinue(ctx, current)) {
      // The same checks as the legacy path: revision, policy admission, and no active retry.
      validateReview();
      const prior = current.retriedBy ? readTask(ctx, current.retriedBy) : null;
      if (prior && ["queued", "running"].includes(prior.state)) throw new CoreError("conflict", `${id} already has an active retry ${prior.id}`);
      const task = await continueWithMessage(ctx, current, { kind: "message", body: `Review feedback: ${v.note}`, replyTo: null, requestId: `sendback:${id}:${current.rev}` }, deps);
      if (task) return { task, retry: task };
      // Managed work never falls back to a legacy retry, which would drop its delegation policy.
      if (getWork(ctx, id)) throw new CoreError("conflict", "The work could not continue its session; use dispatch.retry with feedback");
    }
    // Both policy decisions finish before the single guarded retry+verdict commit.
    let reviewed:TaskRecord|undefined;
    const result=await retry(ctx,id,{executor,expectRev:initialTask.rev,...(verdict==="send_back"?{feedback:v.note}:{})},{
      ...deps,
      beforeCommit:()=>{deps.beforeCommit?.();validateReview();},
      afterCommit:(parent,child)=>{reviewed=record(verdict,executor,parent.rev);deps.afterCommit?.(reviewed,child);},
    });
    if(!reviewed)throw new CoreError("conflict","Review retry did not consume its admitted commit");
    return {task:apiTask(ctx,reviewed),retry:apiTask(ctx,readTask(ctx,result.retry.id)??result.retry)};
  }
  const task=withTaskLock(ctx,id,()=>{validateReview();return record(verdict,executor);});
  await autoCleanTask(ctx, id);
  return { task: apiTask(ctx, task) };
  } catch(error) {
    // Policy fingerprints also cover task state. Preserve the public revision
    // conflict projection when that task changed, including during the call.
    if(error instanceof CoreError&&error.code==="conflict"){
      const current=readTask(ctx,id);if(current)checkRev(ctx,current,initialTask.rev);
    }
    throw error;
  } finally {finishUnlaunchedWorkSync(ctx,reviewLease);}
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
  let answerWorktree: string | undefined;
  if (o.answerText !== undefined && before?.state === "needs_input" && before.question && before.question.answer === undefined && !before.retriedBy) {
    const worktree = [before.result?.worktree, before.worktree, !before.run?.host ? before.run?.workdir : undefined].find(p => p && p.startsWith("/"));
    if (worktree) {
      const head = await boundedGitRead(ctx.run, ["git", "-C", worktree, "rev-parse", "--verify", "HEAD"], 10_000);
      if (head.code === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) { answerBase = head.stdout.trim(); answerWorktree = worktree; }
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
      const prepared = withTaskLock(ctx, id, () => {
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
        const workParent = getWork(ctx, task.id)?.parentId;
        const origin = task.origin ?? (workParent ? `task:${workParent}` : undefined);
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
          // The retry belongs to whoever the original belongs to, not to whoever retried it.
          ...(origin ? { origin } : {}),
        };
        return {task,input,answering};
      });
      const {task,input,answering}=prepared;
      let linked=false;
      const commitWith=(commit:()=>TaskRecord)=>withTaskLock(ctx,id,()=>{
        const current=readTask(ctx,id);
        if(!current || current.rev!==task.rev) throw new CoreError("conflict","Task changed during retry admission");
        deps.beforeCommit?.();
        const next=commit();
        if(readTask(ctx,next.id)) updateTask(ctx,next.id,t=>{
          t.retryOf=task.id;
          if(o.fromPanel)t.fromPanel=true;
          if(missingBranch)t.placement={...t.placement,requested:t.placement?.requested??"new",why:"previous worktree and branch are gone; creating a new worktree"};
        });
        const parent=updateTask(ctx,task.id,t=>{t.retriedBy=next.id;if(answering){t.question!.answer=o.answerText;t.question!.answeredAt=ctx.now;}});
        linked=true;
        const retried=readTask(ctx,next.id)??next;
        taskActivity(ctx,retried,"retry",`Delegated “${taskTitle(retried)}” to ${executorName(retried.executor??retried.requestedExecutor)}`);
        if(answerFromBase)taskActivity(ctx,retried,"message",`The asking worktree was removed; the answer starts from the recorded base ${answerBase!.slice(0,12)}`);
        deps.afterCommit?.(parent,retried);
        return next;
      });
      const admitted:DelegateInput={...input,commitWith,admissionTaskLock:id,admissionContext:()=>JSON.stringify(readTask(ctx,id)),
        ...(answerWorktree?{admissionPaths:[answerWorktree],admissionPrepare:async()=>{
          const head=await boundedGitRead(ctx.run,["git","-C",answerWorktree!,"rev-parse","--verify","HEAD"],10_000);
          if(head.code!==0||head.stdout.trim()!==answerBase)throw new CoreError("conflict","Asking executor checkout changed during answer admission");
        }}:{}),
      };
      let next:TaskRecord;
      try {next=await (deps.delegate??delegate)(ctx,admitted);}
      catch(error){throw toCoreError(error);}
      if(!linked) throw new CoreError("conflict","Retry delegate did not consume its admitted commit");
      const retried=readTask(ctx,next.id)??next;
      return {retry:retried,of:readTask(ctx,id)!};
    };
    return locked(0);
  }); } finally {finishUnlaunchedWorkSync(ctx,lease);}
}

/** Re-delegate a brief; serializes with answers on the same task. */
export function retry(ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean; feedback?: string; expectRev?: number } = {}, deps: RetryDeps = {}) {
  return retryTask(ctx, id, o, deps);
}

/** Answer exactly once, creating a retry on the executor that asked. */
export async function answer(ctx: Ctx, id: string, text: string, o: { expectRev?: number } = {}, deps: RetryDeps = {}): Promise<{task: ApiTask; retry: ApiTask}> {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", "executors cannot delegate onward");
  if (typeof text !== "string" || text.length < 1 || text.length > 2000) throw new CoreError("invalid_input", "answer must contain 1–2000 characters");
  const current = readTask(ctx, id);
  let expectRev = o.expectRev;
  if (current && canContinue(ctx, current)) {
    // The same checks as the legacy path: revision, and an unanswered question.
    checkRev(ctx, current, o.expectRev);
    if (current.state !== "needs_input" || !current.question || current.question.answer !== undefined || current.retriedBy) {
      throw new CoreError("conflict", "task is not waiting for an answer", undefined, { task: apiTask(ctx, current) });
    }
    const question = msgStore.thread(ctx, id).filter(m => m.kind === "question" && m.from === `task:${id}`).at(-1);
    const setAnswer = (answer?: string) => updateTask(ctx, id, t => {
      if (!t.question) return;
      if (answer === undefined) { delete t.question.answer; delete t.question.answeredAt; } else { t.question.answer = answer; t.question.answeredAt = ctx.now; }
    });
    const task = await continueWithMessage(ctx, current, { kind: "answer", body: text, replyTo: question?.id ?? null, requestId: `answer:${id}:${current.rev}` }, deps,
      () => setAnswer(text), () => setAnswer());
    if (task) {
      if (question) readMessages(ctx, question.to, [question.id]);
      return { task, retry: task };
    }
    if (getWork(ctx, id)) throw new CoreError("conflict", "The work could not continue its session; use dispatch.answer with a requestId and revision");
    expectRev = readTask(ctx, id)?.rev;
  }
  const r = await retryTask(ctx, id, {...o, expectRev, answerText:text}, deps);
  return {task:apiTask(ctx,r.of),retry:apiTask(ctx,r.retry)};
}

export { clean, cleanTask, autoCleanTask, autoCleanSweep, cleanTestHooks, verifiedTaskWorktreeRoot } from "../tasks/cleanup";
