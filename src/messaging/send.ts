import { CoreError } from "../core/errors";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { callerParticipant, rootOf, taskOf } from "./participants";
import { checkSend } from "./policy";
import { readTask, updateTask } from "../tasks/store";
import * as store from "./store";
import { assertOpen, deliver, notifyMessage, readMessages, type Delivery, type TurnDelivery, type TurnHold } from "./turns";
import { participantSchema, type Message, type MsgKind } from "./types";

export interface SendInput { to: string; kind?: MsgKind; body: string; replyTo?: string; requestId?: string }
export interface SendDeps { appAuthenticated?: boolean; participant?: string; spawnRunner?: SpawnRunner }

export interface SendResult { message: Message; duplicate: boolean; delivery: Delivery; hold?: TurnHold }

export async function sendMessage(ctx: Ctx, input: SendInput, deps: SendDeps = {}): Promise<SendResult> {
  if (!participantSchema.safeParse(input.to).success) throw new CoreError("invalid_input", `Invalid participant ${input.to}`);
  const kind = input.kind ?? "message";
  if (kind === "nudge") throw new CoreError("not_allowed", "Only the broker sends nudges", undefined, { reason: "msg_forbidden", layer: "protocol" });
  if (kind === "answer" && !input.replyTo) throw new CoreError("invalid_input", "An answer needs reply_to");
  const body = input.body.trim();
  if (!body) throw new CoreError("invalid_input", "Message body is empty");
  const caller = callerParticipant(ctx, deps);
  // A retried request returns what it stored before any routing, closing or rate check can refuse it.
  const prior = input.requestId ? store.byRequest(ctx, caller.id, input.requestId) : null;
  if (prior) return duplicate(ctx, prior, store.fingerprint(input.to, kind, body), deps);
  assertOpen(ctx, input.to);
  const verdict = checkSend(ctx, { from: caller.id, to: input.to, kind, bytes: Buffer.byteLength(body, "utf8"), hasGrant: !!caller.grant });
  const taskId = taskOf(input.to) ?? taskOf(caller.id);
  const root = taskOf(input.to) ? rootOf(ctx, input.to) : rootOf(ctx, caller.id);
  const r = store.insertMessage(ctx, { taskId, rootId: root, from: caller.id, to: input.to, kind, body, replyTo: input.replyTo ?? null,
    requestId: input.requestId ?? null, status: verdict.hold ? "held" : "pending" });
  if (r.duplicate) return duplicate(ctx, { ...r.message, fingerprint: store.byRequest(ctx, caller.id, input.requestId!)?.fingerprint ?? null }, store.fingerprint(input.to, kind, body), deps);
  void notifyMessage(ctx, r.message);
  // A turn the guardrail allowed still passes project policy; a policy hold says why (ADR 0015).
  const { delivery, hold } = verdict.hold ? { delivery: "held" as const, hold: undefined } : await deliverMessage(ctx, r.message, deps);
  return { ...r, delivery, ...(hold ? { hold } : {}) };
}

/**
 * Deliver a pending message. An answer is recorded on the task's question before the turn starts, as pacer answer does;
 * an answer that reaches no turn, or whose delivery fails, leaves the task's question open for the legacy retry.
 * The question is read once delivery is decided; an answer project policy held leaves it unread, so it can be answered again.
 */
async function deliverMessage(ctx: Ctx, m: Message, deps: SendDeps): Promise<TurnDelivery> {
  const answered = m.kind === "answer" && m.replyTo ? recordAnswer(ctx, m.from, m.to, m.replyTo, m.body) : undefined;
  let result: TurnDelivery;
  try { result = await deliver(ctx, m.to, deps.spawnRunner); }
  catch (e) { answered?.undo?.(); throw e; }
  if (answered && result.delivery !== "turn_started" && result.delivery !== "queued") answered.undo?.();
  if (answered && result.delivery !== "held") readMessages(ctx, answered.question.to, [answered.question.id]);
  return result;
}

/**
 * An answer to a task's question, as pacer answer records it: the task's question is answered before the turn starts,
 * and the caller marks the question read once delivery is decided. Returns the question and how to reopen the
 * task's question (absent when it was not open), or undefined when the reply is not to a question from that task.
 */
function recordAnswer(ctx: Ctx, caller: string, to: string, replyTo: string, body: string): { question: Message; undo?: () => void } | undefined {
  const question = answeredQuestion(ctx, caller, to, replyTo);
  const id = taskOf(to);
  if (!question || !id) return undefined;
  const task = readTask(ctx, id);
  if (!task?.question || task.question.answer !== undefined) return { question };
  updateTask(ctx, id, t => { if (t.question && t.question.answer === undefined) { t.question.answer = body; t.question.answeredAt = ctx.now; } });
  return { question, undo: () => updateTask(ctx, id, t => { if (t.question?.answer === body) { delete t.question.answer; delete t.question.answeredAt; } }) };
}

/** The question from task `to` that the caller's reply answers, or undefined when the reply is not to one. */
function answeredQuestion(ctx: Ctx, caller: string, to: string, replyTo: string): Message | undefined {
  const question = store.getMessage(ctx, replyTo);
  if (!question || question.kind !== "question" || !taskOf(to) || question.from !== to || (question.to !== caller && caller !== "human")) return undefined;
  return question;
}

async function duplicate(ctx: Ctx, prior: Message & { fingerprint: string | null }, fingerprint: string, deps: SendDeps): Promise<SendResult> {
  if (prior.fingerprint !== null && prior.fingerprint !== fingerprint) {
    throw new CoreError("conflict", "That request id was already used for a different message", undefined, { reason: "msg_request_mismatch" });
  }
  const { fingerprint: _, ...message } = prior;
  if (message.status === "held") return { message, duplicate: true, delivery: "held" };
  // The first delivery never started a turn (project policy may have held it): try again, answering the question as a first send does.
  if (message.status === "pending") {
    const { delivery, hold } = await deliverMessage(ctx, message, deps);
    return { message, duplicate: true, delivery, ...(hold ? { hold } : {}) };
  }
  // Another turn already took the answer, so its question is read.
  const answered = message.kind === "answer" && message.replyTo ? answeredQuestion(ctx, message.from, message.to, message.replyTo) : undefined;
  if (answered) readMessages(ctx, answered.to, [answered.id]);
  return { message, duplicate: true, delivery: "queued" };
}
