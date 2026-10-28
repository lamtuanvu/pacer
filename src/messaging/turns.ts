import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import { launchTaskRunner, spawnRunner as defaultSpawn, type SpawnRunner } from "../tasks/api";
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
export const turnKey = (t: TaskRecord) => `${t.id}#${t.attempts.length + 1}`;

export function notifyMessage(ctx: Ctx, m: Message): void {
  // Task 7 registers the "message" entity kind in src/link/envelope.ts.
  void publish(ctx, [{ type: "entity", data: { kind: "message", id: m.id, value: m } }]);
}

/** Begin a resume turn when the task is settled and has pending messages. */
export function startTurnIfIdle(ctx: Ctx, id: string, spawn: SpawnRunner = defaultSpawn): Delivery {
  let start = false;
  const result = withTaskLock(ctx, id, (): Delivery => {
    const t = readTask(ctx, id);
    if (!t || isClosed(t)) return "closed";
    if (t.interactionMode === "conversation") return "live_unavailable";
    if (t.state === "queued" || t.state === "running") return "queued";
    if (!store.pendingFor(ctx, `task:${id}`).length) return "queued";
    const executor = sessionAgent(t);
    if (!executor) return "no_session";
    const root = rootOf(ctx, `task:${id}`);
    if (store.turnsForRoot(ctx, root) >= effectivePolicy(ctx, { root }).config.tree.max_turns) return "cap";
    updateTask(ctx, id, x => {
      x.pendingTurn = { id: turnKey(x), executor, at: ctx.now };
      x.requestedExecutor = executor;
      x.state = "queued";
      delete x.result;
      if (x.question && x.question.answer === undefined) delete x.question;
    });
    start = true;
    return "turn_started";
  });
  // Same environment scrub as the managed restart in src/core/work.ts:171.
  if (start) launchTaskRunner({ ...ctx, env: { ...ctx.env, PACER_WORK_GRANT: undefined, PACER_ROLE: undefined } }, id, spawn);
  return result;
}

export function deliver(ctx: Ctx, to: string, spawn?: SpawnRunner): Delivery {
  const id = taskOf(to);
  if (!id) return "pull";
  return startTurnIfIdle(ctx, id, spawn);
}

const label = (p: string) => p === "human" ? "the user" : p.startsWith("external:") ? `planner ${p.slice(9)}` : `task ${p.slice(5)}`;

export function renderTurnPrompt(ctx: Ctx, task: TaskRecord, messages: Message[]): string {
  const parent = parentOf(ctx, `task:${task.id}`) ?? "human";
  const blocks = messages.map(m => `--- ${m.kind} ${m.id} from ${label(m.from)} (${m.from}) ---\n${m.body}`);
  return [
    `You are continuing pacer task ${task.id} in the same workspace. New messages:`,
    ...blocks,
    "---",
    `Your final response in this turn is sent to ${label(parent)} (${parent}) as your report.`,
    `To message another participant or ask a question, run: pacer msg send --to <participant> "<text>" [--question]`,
    "Do not commit.",
  ].join("\n\n");
}

/** Called at launch: claim pending messages for this attempt and record the turn. */
export function claimTurnMessages(ctx: Ctx, task: TaskRecord): { turnId: string; messages: Message[] } | null {
  if (!task.pendingTurn) return null;
  const turnId = task.pendingTurn.id;
  const messages = store.claimPending(ctx, `task:${task.id}`, turnId);
  store.recordTurn(ctx, { id: turnId, taskId: task.id, rootId: rootOf(ctx, `task:${task.id}`), at: ctx.now });
  for (const m of messages) notifyMessage(ctx, m);
  return { turnId, messages };
}

/** After a run settles: report to the parent once per attempt, then deliver anything that arrived meanwhile. */
export function onRunEnded(ctx: Ctx, id: string, spawn?: SpawnRunner): void {
  const t = readTask(ctx, id);
  if (!t || t.interactionMode === "conversation" || ["queued", "running"].includes(t.state)) return;
  const turnId = t.pendingTurn?.id ?? `${id}#${t.attempts.length}`;
  const limited = t.state === "limit" || !!t.attempts.at(-1)?.limitHit;
  if (t.pendingTurn) {
    store.endTurn(ctx, turnId, t.state, ctx.now);
    if (limited) store.releaseTurn(ctx, turnId);
    updateTask(ctx, id, x => { delete x.pendingTurn; });
  }
  const parent = parentOf(ctx, `task:${id}`);
  const started = t.attempts.at(-1)?.startedAt ?? t.createdAt;
  const spoke = store.sentSince(ctx, `task:${id}`, started).some(m => m.to === parent && ["report", "question", "message"].includes(m.kind));
  if (parent && !spoke && !limited && t.state !== "needs_input") {
    const body = (t.result?.report ?? `Run ended: ${t.state}`).slice(-REPORT_BYTES);
    const r = store.insertMessage(ctx, { taskId: id, rootId: rootOf(ctx, `task:${id}`), from: `task:${id}`, to: parent, kind: "report",
      body: `[${t.state}] ${body}`.trim(), replyTo: null, requestId: `report:${turnId}` });
    if (!r.duplicate) { notifyMessage(ctx, r.message); deliver(ctx, parent, spawn); }
  }
  if (!limited) startTurnIfIdle(ctx, id, spawn);
}

export function assertOpen(ctx: Ctx, to: string): void {
  const id = taskOf(to);
  if (!id) return;
  const t = readTask(ctx, id);
  if (!t) throw new CoreError("not_found", `Unknown task ${id}`);
  if (isClosed(t)) throw new CoreError("conflict", `Task ${id} is closed for messages`, undefined, { reason: "msg_node_closed" });
  if (t.interactionMode === "conversation" && participantKind(to) === "launched") {
    throw new CoreError("conflict", "Messages to live conversations arrive in a later release", undefined, { reason: "msg_live_unavailable" });
  }
}
