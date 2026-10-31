import { getWork } from "../dispatch/work";
import { listTasksWhere } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { parentOf, participantKind, taskOf } from "./participants";
import { effectivePolicy } from "./policy";
import { getMessage, messagesDatabase } from "./store";
import { isClosed } from "./turns";
import type { Message } from "./types";

export type StallReason = "undelivered" | "idle_run" | "unread_external" | "unread_human" | "cycle";
/**
 * A participant that holds the next move. `blocking` lists the nodes waiting on it; in a cycle, `waitingOn` is the
 * member it waits on and `deepest` the launched member with the greatest depth, if any.
 */
export interface Stall { node: string; reason: StallReason; waitingOn?: string; blocking: string[]; deepest?: string }
/** `parent` is the participant a task reports to; `depth` counts task hops from its tree's root (0). */
export interface SnapshotTask { task: TaskRecord; work: boolean; parent: string | null; depth: number }
export interface LivenessSnapshot { tasks: SnapshotTask[]; unread: Message[]; questions: Message[]; retryDelivery: boolean }

const WINDOW_S = 7 * 86400;
const OPEN_STATES = ["queued", "running", "done", "partial", "failed", "limit", "needs_input"] as const;

/** Reads the open tasks, unread messages and unanswered questions the analysis needs. */
export function buildSnapshot(ctx: Ctx): LivenessSnapshot {
  const tasks = listTasksWhere(ctx, { states: [...OPEN_STATES], updatedSince: ctx.now - WINDOW_S }).filter(t => !isClosed(t)).map(task => {
    const self = `task:${task.id}`;
    const parent = parentOf(ctx, self);
    let depth = 0;
    for (let p = parent; p && taskOf(p) && depth < 64; p = parentOf(ctx, p)) depth++;
    return { task, work: !!getWork(ctx, task.id), parent, depth };
  });
  const db = messagesDatabase(ctx);
  const ids = (sql: string, ...args: number[]) => db.query<{ id: string }, number[]>(sql).all(...args).map(r => getMessage(ctx, r.id)!).filter(Boolean);
  const unread = ids("SELECT id FROM messages WHERE status IN ('pending','delivered') ORDER BY id");
  const questions = ids(`SELECT id FROM messages q WHERE kind='question' AND status<>'held' AND created_at>=?
    AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to=q.id AND a.kind='answer') ORDER BY id`, ctx.now - WINDOW_S);
  return { tasks, unread, questions, retryDelivery: effectivePolicy(ctx).config.liveness.retry_delivery };
}

/** Pure: who holds the next move in each open conversation that is not moving. Nodes without a stall are absent. */
export function analyzeLiveness(snapshot: LivenessSnapshot, _now: number): Stall[] {
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
    if (t.state === "running" && t.progress?.phase === "idle") stalls.set(p, { node: p, reason: "idle_run", blocking: blocking(p) });
    else if (!active(p) && (!n.work || snapshot.retryDelivery) && unread.some(m => m.to === p && m.status === "pending")) {
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
