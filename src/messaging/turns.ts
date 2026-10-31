import { existsSync } from "node:fs";
import { CoreError } from "../core/errors";
import type { OutboxEvent } from "../link/envelope";
import { publish } from "../link/publish";
import { publishTaskMessages } from "./publish";
import { launchTaskRunner, spawnRunner as defaultSpawn, type SpawnRunner } from "../tasks/api";
import { loadStrategy, type ProviderCfg, type Strategy } from "../config/strategy";
import { appendActivity } from "../activity/log";
import { executorsFor } from "../engine/rank";
import { admissionLifetime } from "../tasks/creation-admission";
import { getWork } from "../dispatch/work";
import { headlessTurnPath } from "../exec/launch";
import { withoutPlannerSession } from "../exec/process";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { parentOf, participantKind, rootOf, taskOf } from "./participants";
import { effectivePolicy } from "./policy";
import * as store from "./store";
import type { Message } from "./types";

export type Delivery = "turn_started" | "queued" | "pull" | "held" | "closed" | "cap" | "live_unavailable" | "no_session";
const REPORT_BYTES = 64 * 1024;

export const isClosed = (t: TaskRecord) => !!t.review || !!t.dismissed || !!t.msgClosed || t.state === "stopped";
const sessionAgent = (t: TaskRecord) => t.run?.executor ?? t.result?.executor ?? null;
/** Unique per turn: the attempt it will run as, then the task's turn count, so a run that ended before any attempt never reuses an id. */
export const turnKey = (ctx: Ctx, t: TaskRecord, replay = false) => `${t.id}#${t.attempts.length + 1}.${store.turnsForTask(ctx, t.id) + 1}${replay ? "r" : ""}`;

export function notifyMessage(ctx: Ctx, m: Message): Promise<unknown> {
  // Task 7 registers the "message" entity kind in src/link/envelope.ts.
  const event: OutboxEvent = { type: "entity", data: { kind: "message", id: m.id, value: m } };
  // A message to or from the human changes what the task shows them and what needs them.
  return m.to === "human" || m.from === "human" ? publishTaskMessages(ctx, [m.taskId], [event]) : publish(ctx, [event]);
}

/** Marks the recipient's messages read; reading the human's updates their tasks' attention at once. */
export function readMessages(ctx: Ctx, to: string, ids: string[], at = ctx.now): number {
  const read = store.markRead(ctx, to, ids, at);
  if (read && to === "human") void publishTaskMessages(ctx, ids.map(id => store.getMessage(ctx, id)?.taskId ?? null));
  return read;
}

/** The runner config for a turn; an executor that is no longer configured has only its id. */
function turnRunner(ctx: Ctx, executor: string): Pick<ProviderCfg, "id" | "via"> {
  try { return loadStrategy(ctx).providers[executor] ?? { id: executor, via: null }; } catch { return { id: executor, via: null }; }
}

/** A message turn can run for this task: it ran locally through the direct backend with an executor that resumes or replays headless. */
export function turnCapable(ctx: Ctx, t: TaskRecord): boolean {
  const executor = sessionAgent(t);
  return !!executor && !t.run?.host && !(t.result?.backend && t.result.backend !== "direct") && !!headlessTurnPath(turnRunner(ctx, executor));
}

/** The task worktree a message turn resumes in; the turn fails when it is gone. */
export const turnWorktree = (t: TaskRecord): string | null => t.worktree ?? t.result?.worktree ?? null;

/** Why no turn can start for this task now, or null when one can. Checked again under the task lock. */
function turnBlocked(ctx: Ctx, t: TaskRecord | null): Delivery | null {
  if (!t || isClosed(t)) return "closed";
  if (getWork(ctx, t.id)) return "pull";
  if (t.interactionMode === "conversation") return "live_unavailable";
  if (t.state === "queued" || t.state === "running") return "queued";
  if (!store.pendingFor(ctx, `task:${t.id}`).length) return "queued";
  if (!sessionAgent(t) || !turnCapable(ctx, t)) return "no_session";
  const root = rootOf(ctx, `task:${t.id}`);
  if (store.turnsForRoot(ctx, root) >= effectivePolicy(ctx, { root }).config.tree.max_turns) return "cap";
  return null;
}

/**
 * Begin a resume turn when the task is settled and has pending messages. A turn runs headless through the direct backend;
 * a runner that cannot do that leaves the messages pending. Managed work nodes read theirs with their grant (plan 1).
 * Callers outside tests use beginTurn, which admits the turn through project policy first.
 */
export function startTurnIfIdle(ctx: Ctx, id: string, spawn: SpawnRunner = defaultSpawn, o: { replay?: boolean; executor?: string; guard?: () => void } = {}): Delivery {
  let start = false;
  const result = withTaskLock(ctx, id, (): Delivery => {
    const t = readTask(ctx, id);
    const blocked = turnBlocked(ctx, t);
    if (blocked || !t) return blocked ?? "closed";
    const prior = sessionAgent(t)!;
    // Policy admitted another executor: it cannot resume the prior session, so it replays the thread.
    const executor = o.executor ?? prior;
    if (executor !== prior && !headlessTurnPath(turnRunner(ctx, executor))) return "no_session";
    const replay = !!o.replay || executor !== prior;
    o.guard?.();
    const root = rootOf(ctx, `task:${id}`);
    // The runner deletes run when the attempt starts, so the session to resume is captured now.
    const session = !replay && t.run?.executor === executor ? t.run.agentSession : undefined;
    const turn = turnKey(ctx, t, replay);
    store.recordTurn(ctx, { id: turn, taskId: id, rootId: root, at: ctx.now });
    updateTask(ctx, id, x => {
      x.pendingTurn = { id: turn, executor, at: ctx.now, ...(session ? { session } : {}), ...(replay ? { replay: true } : {}) };
      x.requestedExecutor = executor;
      x.state = "queued";
      x.worktree = x.worktree ?? x.result?.worktree;
      if (!x.worktree) delete x.worktree;
      delete x.result; delete x.settledAt; delete x.queue; delete x.reviewRequest; delete x.progress; delete x.runnerPid;
      if (x.question && x.question.answer === undefined) delete x.question;
    });
    start = true;
    return "turn_started";
  });
  // Same environment scrub as the managed restart in src/core/work.ts:171, and the sender's planner session is not the runner's.
  if (start) launchTaskRunner({ ...ctx, env: { ...withoutPlannerSession(ctx.env), PACER_WORK_GRANT: undefined, PACER_ROLE: undefined } }, id, spawn);
  return result;
}

/** Why project policy holds a task's next message turn. */
export interface TurnHold { reason: string; plugin?: string }
export interface TurnDelivery { delivery: Delivery; hold?: TurnHold }

/** The task's executors that could run its next turn: the prior one first, then its routing rule's local headless executors. */
function turnCandidates(ctx: Ctx, t: TaskRecord, prior: string): string[] {
  let s: Strategy;
  try { s = loadStrategy(ctx); } catch { return [prior]; }
  const planner = (id: string) => s.runners[id]?.agent === s.planner.agent && s.runners[id]?.account === s.planner.account;
  const others = executorsFor(t.kind ?? null, s).filter(id => id !== prior && s.runners[id]?.enabled !== false && !planner(id) && !!headlessTurnPath(turnRunner(ctx, id)));
  return [prior, ...new Set(others)];
}

const policyHold = (e: CoreError): TurnHold => ({ reason: e.message, ...(e.hint?.startsWith("plugin ") ? { plugin: e.hint.slice(7) } : {}) });

/**
 * A continuation turn is a new attempt, so it passes the same project policy as one: the delegate decision for the task's
 * brief and executor, then the route decision over the executors that can run the turn. The prior executor resumes its session
 * while policy still admits it; otherwise the first admitted executor replays the thread. A veto, or no admitted executor, holds it.
 */
async function admitTurn(ctx: Ctx, t: TaskRecord): Promise<{ executor: string; guard: () => void } | TurnHold> {
  const prior = sessionAgent(t)!;
  const { applyPolicy } = await import("../plugins/policy");
  const context = () => { const x = readTask(ctx, t.id); return JSON.stringify(x && { executor: sessionAgent(x), state: x.state, attempts: x.attempts.length, kind: x.kind, repo: x.brief.repo, worktree: turnWorktree(x) }); };
  const placement = t.placement?.mode ?? (t.placement?.requested === "current" || t.placement?.requested === "new" ? t.placement.requested : "auto");
  try {
    const delegate = await applyPolicy(ctx, "delegate", { goal: t.brief.goal, repo: t.brief.repo, kind: t.kind ?? null, requestedExecutor: prior, placement },
      { contextFingerprint: context, eligibleRunnerIds: [prior], allowedPlacements: [placement], validateDelegate: () => false, ...admissionLifetime(ctx) });
    const route = await applyPolicy(ctx, "route", { taskId: t.id, candidates: turnCandidates(ctx, t, prior) }, { contextFingerprint: context, ...admissionLifetime(ctx) });
    if (route.params.decision !== "route") throw new CoreError("invalid_input", "Invalid route policy receipt");
    const admitted = route.params.input.candidates;
    const executor = admitted.includes(prior) ? prior : admitted[0];
    if (!executor) {
      const plugins = [...new Set(Object.values(route.excludedBy))];
      return { reason: `No executor is admitted for this task's next turn${plugins.length ? ` (excluded by plugin ${plugins.join(", ")})` : ""}`, ...(plugins.length === 1 ? { plugin: plugins[0] } : {}) };
    }
    return { executor, guard: () => { delegate.revalidate(); route.revalidate(); } };
  } catch (e) {
    if (e instanceof CoreError && (e.code === "not_allowed" || e.code === "plugin_timeout")) return policyHold(e);
    throw e;
  }
}

/** Tell each sender of a held turn's messages why they wait, once per set of pending messages. */
async function reportHold(ctx: Ctx, id: string, hold: TurnHold, spawn?: SpawnRunner): Promise<void> {
  const pending = store.pendingFor(ctx, `task:${id}`);
  const last = pending.at(-1);
  if (!last) return;
  appendActivity(ctx, { kind: "message", level: "warn", text: `Messages to task ${id} are held: ${hold.reason}`, taskId: id });
  const body = `Messages to task ${id} are held by project policy and stay pending: ${hold.reason}. They are delivered with the next message once policy admits a turn.`;
  for (const from of new Set(pending.map(m => m.from).filter(f => f !== `task:${id}`))) await report(ctx, id, from, "[held]", body, `held:${last.id}:${from}`, spawn);
}

/**
 * Start the task's next message turn after fresh policy admission (ADR 0015), retrying when the policy context changed meanwhile.
 * A held turn leaves its messages pending, records why in the task's activity, and reports it to their senders unless quiet.
 */
export async function beginTurn(ctx: Ctx, id: string, spawn: SpawnRunner = defaultSpawn, o: { replay?: boolean; quiet?: boolean } = {}): Promise<TurnDelivery> {
  for (let attempt = 0; ; attempt++) {
    const t = readTask(ctx, id);
    const blocked = turnBlocked(ctx, t);
    if (blocked || !t) return { delivery: blocked ?? "closed" };
    const admitted = await admitTurn(ctx, t);
    if (!("executor" in admitted)) {
      if (!o.quiet) await reportHold(ctx, id, admitted, spawn);
      return { delivery: "held", hold: admitted };
    }
    try { return { delivery: startTurnIfIdle(ctx, id, spawn, { replay: o.replay, executor: admitted.executor, guard: admitted.guard }) }; }
    catch (e) { if (attempt < 2 && e instanceof CoreError && e.code === "conflict") continue; throw e; }
  }
}

export function deliver(ctx: Ctx, to: string, spawn?: SpawnRunner): Promise<TurnDelivery> {
  const id = taskOf(to);
  if (!id) return Promise.resolve({ delivery: "pull" });
  return beginTurn(ctx, id, spawn);
}

const label = (p: string) => p === "human" ? "the user" : p.startsWith("external:") ? `planner ${p.slice(9)}` : `task ${p.slice(5)}`;

export function renderTurnPrompt(ctx: Ctx, task: TaskRecord, messages: Message[]): string {
  const parent = parentOf(ctx, `task:${task.id}`) ?? "human";
  const blocks = messages.map(m => `--- ${m.kind} ${m.id} from ${label(m.from)} (${m.from}) ---\n${m.body}`);
  return [
    `You are continuing pacer task ${task.id} in the same workspace. New messages:`,
    ...blocks,
    "---",
    `Your final response in this turn is sent to ${label(parent)} (${parent}) as your report. This turn runs headless: do not run \`pacer report\`.`,
    `To message another participant or ask a question, run: pacer msg send --to <participant> "<text>" [--question]`,
    "Do not commit.",
  ].join("\n\n");
}

const REPLAY_BYTES = 64 * 1024;
/** For a fresh launch of a turn: the task's earlier thread, newest kept when it is long. */
export function renderReplayThread(ctx: Ctx, task: TaskRecord, current: Message[]): string {
  const skip = new Set(current.map(m => m.id));
  const blocks = store.thread(ctx, task.id, { limit: 1000 }).filter(m => !skip.has(m.id) && m.status !== "held")
    .map(m => `--- ${m.kind} ${m.id} from ${label(m.from)} (${m.from}) to ${label(m.to)} (${m.to}) ---\n${m.body}`);
  const kept: string[] = [];
  let bytes = 0;
  for (const b of blocks.reverse()) { bytes += Buffer.byteLength(b); if (bytes > REPLAY_BYTES) break; kept.unshift(b); }
  if (!kept.length) return "";
  return [`Your earlier session for this task is unavailable. The conversation so far${kept.length < blocks.length ? " (most recent part)" : ""}:`, ...kept].join("\n\n");
}

/** Called at launch: claim pending messages for this attempt. The turn was recorded when it started. */
export function claimTurnMessages(ctx: Ctx, task: TaskRecord): { turnId: string; messages: Message[] } | null {
  if (!task.pendingTurn) return null;
  const turnId = task.pendingTurn.id;
  const messages = store.claimPending(ctx, `task:${task.id}`, turnId);
  for (const m of messages) void notifyMessage(ctx, m);
  return { turnId, messages };
}

async function report(ctx: Ctx, id: string, parent: string, head: string, body: string, requestId: string, spawn?: SpawnRunner): Promise<void> {
  const r = store.insertMessage(ctx, { taskId: id, rootId: rootOf(ctx, `task:${id}`), from: `task:${id}`, to: parent, kind: "report",
    body: `${head} ${readable(body).slice(-REPORT_BYTES)}`.trim(), replyTo: null, requestId });
  if (!r.duplicate) { void notifyMessage(ctx, r.message); await deliver(ctx, parent, spawn); }
}

/** An agent CLI's JSON error result (Claude's stream-json) as one readable line; other text is kept. */
function readable(text: string): string {
  return text.split("\n").map(line => {
    if (!/^\s*\{.*"type"\s*:\s*"result"/.test(line)) return line;
    try {
      const r = JSON.parse(line) as { is_error?: boolean; subtype?: string; errors?: unknown; result?: unknown };
      if (!r.is_error && !String(r.subtype ?? "").startsWith("error")) return typeof r.result === "string" ? r.result : line;
      const errors = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string") : [];
      return `Agent error (${r.subtype ?? "error"}): ${errors.join("; ") || (typeof r.result === "string" ? r.result : "no details")}`;
    } catch { return line; }
  }).join("\n");
}

/** Who reads this task's run-end report: its origin. Work children report through dispatch.review; legacy tasks have no reader. */
function reportReader(ctx: Ctx, t: TaskRecord): string | null {
  const work = getWork(ctx, t.id);
  if (work?.parentId) return null;
  return t.origin ?? null;
}

const REJECTED_RESUME = /No conversation found|error_during_execution/;
/** The turn's attempt resumed a native session and the agent CLI rejected it: a nonzero exit or a resume error in its output. */
function rejectedResume(t: TaskRecord): boolean {
  const attempt = t.attempts.at(-1);
  if (!attempt || !t.run || t.run.attempt !== t.attempts.length || t.run.turnResume === "replayed") return false;
  if (attempt.timedOut || attempt.limitHit || ["stopped", "needs_input", "limit"].includes(t.state)) return false;
  return attempt.exitCode !== 0 || REJECTED_RESUME.test(t.result?.report ?? "");
}

/** A report the agent itself sent, as opposed to a run-end report pacer wrote for an earlier run. */
const agentReport = (m: Message) => m.kind === "report" && !/^(report|undelivered):/.test(m.requestId ?? "");

/**
 * After a run settles: report to the parent once per attempt, then deliver anything that arrived meanwhile.
 * A turn whose run never claimed its messages is not restarted; a rejected resume is retried once as a replay.
 */
export async function onRunEnded(ctx: Ctx, id: string, spawn?: SpawnRunner): Promise<void> {
  const t = readTask(ctx, id);
  if (!t || t.interactionMode === "conversation" || ["queued", "running"].includes(t.state)) return;
  // Called again for a run whose turn already ended: that call reported it.
  const ended = t.pendingTurn ? null : store.lastTurnEndedAt(ctx, id);
  if (ended !== null && ended >= (t.attempts.at(-1)?.endedAt ?? 0)) return;
  const turnId = t.pendingTurn?.id ?? `${id}#${t.attempts.length}`;
  const limited = t.state === "limit" || !!t.attempts.at(-1)?.limitHit;
  const parent = reportReader(ctx, t);
  // Messages a run never picked up wait for the next send instead of relaunching on their own.
  let restart = !limited && store.lastTurnOutcome(ctx, id) !== "undelivered";
  let turnMessages: Message[] = [];
  let rejected = false;
  if (t.pendingTurn) {
    turnMessages = store.claimedMessages(ctx, turnId);
    const claimed = turnMessages.length > 0;
    store.endTurn(ctx, turnId, claimed ? t.state : "undelivered", ctx.now);
    updateTask(ctx, id, x => { delete x.pendingTurn; });
    restart = !limited && claimed;
    if (limited) store.releaseTurn(ctx, turnId);
    else if (!claimed) {
      // The run ended before it picked up the messages: they stay pending, and the sender learns why.
      const why = (t.result?.report ?? "").trim().split("\n").filter(Boolean).slice(-5).join("\n");
      if (parent) await report(ctx, id, parent, `[not delivered] The run for task ${id} ended (${t.state}) before it received your messages; they are still pending.`, why ? `\n\n${why}` : "", `undelivered:${turnId}`, spawn);
      return;
    } else if (!t.pendingTurn.replay && rejectedResume(t)) {
      // A rejected resume (unknown session, missing history): put the messages back and replay the thread once.
      rejected = true;
      store.releaseTurn(ctx, turnId);
      if ((await beginTurn(ctx, id, spawn, { replay: true })).delivery === "turn_started") return;
      restart = false;
    }
  }
  const since = t.pendingTurn?.at ?? t.attempts[0]?.startedAt ?? t.createdAt;
  // Only a report the agent already sent replaces the run-end report; progress messages and questions do not.
  const reported = store.sentSince(ctx, `task:${id}`, since).some(m => m.to === parent && agentReport(m));
  if (!limited && t.state !== "needs_input") {
    const body = rejected ? `The agent could not resume its session, and a replay could not start; your messages are still pending.\n\n${t.result?.report ?? ""}`
      : t.result?.report ?? `Run ended: ${t.state}`;
    if (parent && !reported) await report(ctx, id, parent, `[${t.state}]`, body, `report:${turnId}`, spawn);
    // Senders other than the parent wait for a reply too, even when the task has no report reader (legacy tasks);
    // a report is never echoed back to the task that sent one.
    const others = new Set(turnMessages.filter(m => m.from !== parent && m.from !== `task:${id}` && m.kind !== "report").map(m => m.from));
    for (const to of others) await report(ctx, id, to, `[${t.state}]`, body, `report:${turnId}:${to}`, spawn);
  }
  if (restart) await beginTurn(ctx, id, spawn);
}

export function assertOpen(ctx: Ctx, to: string): void {
  const id = taskOf(to);
  if (!id) return;
  const t = readTask(ctx, id);
  if (!t) throw new CoreError("not_found", `Unknown task ${id}`);
  if (isClosed(t)) throw new CoreError("conflict", `Task ${id} is closed for messages`, undefined, { reason: "msg_node_closed" });
  // A settled task's next turn resumes in its worktree; once cleanup removed it, the message could never be delivered.
  const wt = turnWorktree(t);
  if (wt && !["queued", "running"].includes(t.state) && t.interactionMode !== "conversation" && !getWork(ctx, id) && turnCapable(ctx, t) && !existsSync(wt)) {
    throw new CoreError("conflict", `Task ${id}'s worktree was cleaned up, so it cannot take another message turn`,
      "Start a new task, or retry this one to restore its worktree from its branch.", { reason: "msg_worktree_unavailable" });
  }
  if (t.interactionMode === "conversation" && participantKind(to) === "launched") {
    throw new CoreError("conflict", "Messages to live conversations arrive in a later release", undefined, { reason: "msg_live_unavailable" });
  }
}
