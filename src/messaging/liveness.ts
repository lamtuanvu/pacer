import { IDLE_AFTER_S, NO_PROGRESS_S, noProgressSeconds, validateExecution } from "../config/execution";
import { loadStrategy } from "../config/strategy";
import { getWork } from "../dispatch/work";
import { readReport } from "../session/reports";
import { listTasksWhere } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { heldOpenForHuman, parentOf, participantKind, taskOf } from "./participants";
import { awaitingRunAnswer, isPlannerTask, pendingLiveAnswers } from "../workflow/live-answer";
import { effectivePolicy } from "./policy";
import { getMessage, messagesDatabase } from "./store";
import { isClosed } from "./turns";
import type { Message } from "./types";

export type StallReason = "undelivered" | "idle_run" | "silent_prompt" | "no_progress" | "unread_external" | "unread_human" | "cycle" | "caller_decision";
/**
 * A participant that holds the next move. `blocking` lists the nodes waiting on it; in a cycle, `waitingOn` is the
 * member it waits on and `deepest` the launched member with the greatest depth, if any.
 */
export interface Stall { node: string; reason: StallReason; waitingOn?: string; blocking: string[]; deepest?: string }
/**
 * `parent` is the participant a task reports to; `depth` counts task hops from its tree's root (0). `lastProgressAt` is the
 * latest file change or commit, attempt start or outgoing message other than a nudge; terminal output is not progress.
 * `silentSince` is when the session entered needs-input (session-status / report `at`), not lastOutputAt — redraws must not reset the timer.
 */
export interface SnapshotTask { task: TaskRecord; work: boolean; parent: string | null; depth: number; lastProgressAt: number; heldOpenForHuman: boolean; silentSince?: number; planner?: boolean }
/**
 * `pendingLiveAnswers` are engine-created answer rows for open planner turns: they wait to be typed on purpose
 * and must not raise an undelivered stall while the planner finishes its response or a viewer holds the terminal.
 */
export interface LivenessSnapshot { tasks: SnapshotTask[]; unread: Message[]; questions: Message[]; retryDelivery: boolean; noProgressS: number; idleAfterS: number; pendingLiveAnswers: Set<string> }

const WINDOW_S = 7 * 86400;
const OPEN_STATES = ["queued", "running", "done", "partial", "failed", "limit", "needs_input"] as const;
/** States in which a task is settled or waiting, so its caller still owes the next move. */
const DECISION_STATES = ["done", "partial", "failed", "limit", "needs_input"] as const;
/**
 * A settled task that owes its planner caller a verdict, an answer or a stop: no review yet, not superseded by
 * a retry, not dismissed, not handed to the human, and started by a planner. A human caller already gets the
 * task's own review item, so it is never part of the caller ladder.
 */
export function owesDecision(t: TaskRecord): boolean {
  return (DECISION_STATES as readonly string[]).includes(t.state) && !t.review && !t.retriedBy && !t.dismissed
    && !t.reviewRequest && !t.resolved && !!t.origin?.startsWith("external:");
}
/** Phases in which a running task is idle (its own stall), waiting on someone else, being driven, or in pacer's own acceptance run. */
const NO_PROGRESS_EXEMPT = new Set(["idle", "needs-input", "driving", "testing"]);

function executionWindows(ctx: Ctx): { noProgressS: number; idleAfterS: number } {
  try {
    const ex = validateExecution(loadStrategy(ctx).execution);
    return { noProgressS: noProgressSeconds(ex), idleAfterS: ex.idleAfterS ?? IDLE_AFTER_S };
  } catch { return { noProgressS: NO_PROGRESS_S, idleAfterS: IDLE_AFTER_S }; }
}

/** True when the running task still owes someone an answer (task.question or an unanswered question message). */
function hasOpenQuestion(p: string, t: TaskRecord, questions: Message[]): boolean {
  if (t.question && t.question.answer === undefined) return true;
  return questions.some(q => q.from === p);
}

/**
 * A delegated interactive session sitting at its prompt with nobody to answer: phase needs-input and
 * no open pacer question. Human `conversation` tasks (`delegate --interactive`) waiting at their prompt
 * are waiting on the human and stay exempt (same as no_progress). Distinct from idle_run (no output)
 * so the broker can nudge without stopping the live terminal.
 */
function silentAtPrompt(t: TaskRecord): boolean {
  if (t.interactionMode === "conversation") return false;
  if (t.state !== "running" || t.progress?.controlled || t.progress?.phase === "driving" || t.progress?.phase === "testing" || t.run?.takeover) return false;
  return t.progress?.phase === "needs-input";
}

/**
 * Wall-clock start of the needs-input wait. Prefer session-status / report.json `at` (stable while the
 * agent sits at the prompt). Do not use lastOutputAt — terminal redraws (viewer attach, spinner) move it.
 */
export function silentPromptSince(t: TaskRecord): number {
  if (t.run?.dir) {
    try {
      const report = readReport(t.run.dir);
      if (report && (report.status === "needs-input" || report.status === "turn-ended") && Number.isFinite(report.at)) return report.at;
    } catch { /* absent or unreadable */ }
  }
  return t.attemptStartedAt ?? t.run?.startedAt ?? t.createdAt;
}

/** Reads the open tasks, unread messages and unanswered questions the analysis needs. */
export function buildSnapshot(ctx: Ctx): LivenessSnapshot {
  const db = messagesDatabase(ctx);
  const lastSent = db.query<{ at: number | null }, [string]>("SELECT MAX(created_at) AS at FROM messages WHERE sender=? AND kind<>'nudge'");
  const tasks = listTasksWhere(ctx, { states: [...OPEN_STATES], updatedSince: ctx.now - WINDOW_S }).filter(t => !isClosed(t)).map(task => {
    const self = `task:${task.id}`;
    const parent = parentOf(ctx, self);
    let depth = 0;
    for (let p = parent; p && taskOf(p) && depth < 64; p = parentOf(ctx, p)) depth++;
    const started = task.attemptStartedAt ?? task.run?.startedAt ?? task.createdAt;
    const lastProgressAt = Math.max(task.progress?.lastChangeAt ?? 0, started, lastSent.get(self)?.at ?? 0);
    const silentSince = silentAtPrompt(task) ? silentPromptSince(task) : undefined;
    return { task, work: !!getWork(ctx, task.id), parent, depth, lastProgressAt,
      // A planner waiting for an answer to its own question is quiet on purpose, like a session its user owns.
      heldOpenForHuman: heldOpenForHuman(ctx, task, parent) || task.kind === "orchestrate" && awaitingRunAnswer(ctx, task.id), ...(isPlannerTask(ctx, task) ? { planner: true } : {}), ...(silentSince !== undefined ? { silentSince } : {}) };
  });
  const ids = (sql: string, ...args: number[]) => db.query<{ id: string }, number[]>(sql).all(...args).map(r => getMessage(ctx, r.id)!).filter(Boolean);
  const unread = ids("SELECT id FROM messages WHERE status IN ('pending','delivered') ORDER BY id");
  const questions = ids(`SELECT id FROM messages q WHERE kind='question' AND status<>'held' AND created_at>=?
    AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to=q.id AND a.kind='answer') ORDER BY id`, ctx.now - WINDOW_S);
  const windows = executionWindows(ctx);
  const pendingLive = new Set<string>();
  for (const n of tasks) if (n.planner) for (const id of pendingLiveAnswers(ctx, n.task.id)) pendingLive.add(id);
  return { tasks, unread, questions, retryDelivery: effectivePolicy(ctx).config.liveness.retry_delivery, pendingLiveAnswers: pendingLive, ...windows };
}

/** Pure: who holds the next move in each open conversation that is not moving. Nodes without a stall are absent. */
export function analyzeLiveness(snapshot: LivenessSnapshot, now: number): Stall[] {
  const open = new Map(snapshot.tasks.filter(n => !isClosed(n.task) && !n.task.archived).map(n => [`task:${n.task.id}`, n]));
  const known = (p: string) => taskOf(p) ? open.has(p) : p === "human" || p.startsWith("external:");
  const active = (p: string) => { const t = open.get(p)?.task; return !!t && (t.state === "queued" || t.state === "running" || !!t.pendingTurn); };
  const unread = snapshot.unread.filter(m => known(m.from) && known(m.to));

  // Edge A→B: A is blocked on B.
  const out = new Map<string, Set<string>>(), into = new Map<string, Set<string>>();
  const edge = (a: string, b: string) => {
    if (a === b || !known(a) || !known(b)) return;
    (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b);
    (into.get(b) ?? into.set(b, new Set()).get(b)!).add(a);
  };
  for (const m of unread) if (!active(m.from)) edge(m.from, m.to);
  for (const q of snapshot.questions) {
    if (active(q.from)) continue;
    if (open.get(q.from)?.task.state === "needs_input" || q.status === "pending" || q.status === "delivered") edge(q.from, q.to);
  }
  for (const [p, n] of open) if (n.task.state === "needs_input" && n.task.question && n.task.question.answer === undefined && n.parent) edge(p, n.parent);

  const blocking = (p: string) => [...(into.get(p) ?? [])].sort();
  const stalls = new Map<string, Stall>();
  for (const [p, n] of open) {
    const t = n.task;
    // A session a person started is idle or quiet because the user owns it, not because the agent stalled.
    if (!n.heldOpenForHuman && t.state === "running" && t.progress?.phase === "idle") stalls.set(p, { node: p, reason: "idle_run", blocking: blocking(p) });
    // Sitting at the prompt with no open question: not waiting on anyone legitimate. Wall-clock from
    // silentSince (report/session-status at), after idle_after_min — distinct from idle_run so the live session is nudged, not stopped.
    else if (!n.heldOpenForHuman && silentAtPrompt(t) && !hasOpenQuestion(p, t, snapshot.questions)) {
      const since = n.silentSince ?? t.attemptStartedAt ?? t.run?.startedAt ?? t.createdAt;
      if (now - since >= snapshot.idleAfterS) stalls.set(p, { node: p, reason: "silent_prompt", blocking: blocking(p) });
    }
    // Output keeps a spinner or retry loop out of idle_run; only progress clears this. A run without a readable worktree
    // (remote, or git failing) cannot show progress; a human typing, or a conversation at its prompt, holds the move.
    else if (!n.heldOpenForHuman && t.state === "running" && t.progress?.gitObserved && !t.progress.controlled && !NO_PROGRESS_EXEMPT.has(t.progress.phase)
      && t.conversation?.activity !== "idle" && t.conversation?.activity !== "waiting" && now - n.lastProgressAt >= snapshot.noProgressS) {
      stalls.set(p, { node: p, reason: "no_progress", blocking: blocking(p) });
    }
    // Nothing carries a message to a planner, running or not — except open-turn live answers waiting to be typed.
    else if ((n.planner || !active(p) && (!n.work || snapshot.retryDelivery))
      && unread.some(m => m.to === p && m.status === "pending" && !snapshot.pendingLiveAnswers.has(m.id))) {
      stalls.set(p, { node: p, reason: "undelivered", blocking: blocking(p) });
    }
  }
  const people = new Set([...unread.map(m => m.to), ...into.keys()].filter(p => !taskOf(p)));
  for (const p of people) stalls.set(p, { node: p, reason: participantKind(p) === "human" ? "unread_human" : "unread_external", blocking: blocking(p) });

  for (const scc of cycles(out)) {
    const members = new Set(scc);
    const launched = scc.filter(p => open.has(p)).sort((a, b) => open.get(b)!.depth - open.get(a)!.depth || a.localeCompare(b));
    for (const p of scc) {
      const waitingOn = [...out.get(p)!].filter(x => members.has(x)).sort()[0];
      stalls.set(p, { node: p, reason: "cycle", waitingOn, blocking: blocking(p), ...(launched[0] ? { deepest: launched[0] } : {}) });
    }
  }
  // The caller owes the next move on a settled task it has not decided yet (design §3). A message it
  // already sent means the conversation moved, so the task node reports that instead.
  for (const [p, n] of open) {
    const t = n.task, caller = n.parent;
    if (!owesDecision(t) || !caller || taskOf(caller) || unread.some(m => m.from === caller && m.to === p)) continue;
    const prev = stalls.get(caller);
    if (prev?.reason === "cycle") continue;
    stalls.set(caller, { node: caller, reason: "caller_decision",
      blocking: [...new Set([...(prev?.blocking ?? []), p])].sort(),
      ...(prev?.waitingOn ? { waitingOn: prev.waitingOn } : {}), ...(prev?.deepest ? { deepest: prev.deepest } : {}) });
  }
  return [...stalls.values()].sort((a, b) => a.node.localeCompare(b.node));
}
/** Strongly connected components with more than one member (Tarjan). */
function cycles(out: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), found: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) !== idx.get(v)) return;
    const scc: string[] = [];
    for (let w = stack.pop()!; ; w = stack.pop()!) { on.delete(w); scc.push(w); if (w === v) break; }
    if (scc.length > 1) found.push(scc.sort());
  };
  for (const v of [...out.keys()].sort()) if (!idx.has(v)) visit(v);
  return found;
}
