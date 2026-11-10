import { CoreError } from "../core/errors";
import { answerLiveTask } from "../core/tasks";
import type { SpawnRunner } from "../tasks/api";
import type { Ctx } from "../types";
import { callerParticipant, rootOf, taskOf } from "./participants";
import { checkSend } from "./policy";
import { directInputAvailable } from "../session/send";
import { readTask, updateTask } from "../tasks/store";
import * as store from "./store";
import { assertOpen, deliver, notifyMessage, readMessages, type Delivery, type TurnDelivery, type TurnHold } from "./turns";
import type { TaskRecord } from "../tasks/types";
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
 * Deliver a pending message. An answer to a question that the target task currently waits on in its own live
 * interactive session is typed into that session at once, exactly as `pacer answer` does: the agent reads nothing
 * else while it waits for its answer, so no turn started here or live poll later would ever deliver it. Any other
 * delivery starts the task's next message turn. An answer that reaches no turn, or whose delivery fails, leaves
 * the task's question open for the legacy retry; the question is read once delivery is decided. An answer project
 * policy held leaves it unread, so it can be answered again.
 */
async function deliverMessage(ctx: Ctx, m: Message, deps: SendDeps): Promise<TurnDelivery> {
  const target = m.kind === "answer" && m.replyTo ? directAnswerTarget(ctx, m) : undefined;
  if (target && await deliverLiveAnswer(ctx, m, target)) return { delivery: "live" };
  const answered = m.kind === "answer" && m.replyTo ? recordAnswer(ctx, m.from, m.to, m.replyTo, m.body) : undefined;
  let result: TurnDelivery;
  try { result = await deliver(ctx, m.to, deps.spawnRunner); }
  catch (e) { answered?.undo?.(); throw e; }
  if (answered && result.delivery !== "turn_started" && result.delivery !== "queued") answered.undo?.();
  if (answered && result.delivery !== "held") readMessages(ctx, answered.question.to, [answered.question.id]);
  return result;
}

/** The task a reply answers, when it currently waits for that answer in its own live interactive run. */
function directAnswerTarget(ctx: Ctx, m: Message): string | undefined {
  const id = taskOf(m.to);
  const question = answeredQuestion(ctx, m.from, m.to, m.replyTo!);
  if (!question || !id) return undefined;
  const task = readTask(ctx, id);
  return task?.question && task.question.answer === undefined && isTaskQuestion(task, question) && directInputAvailable(task) ? id : undefined;
}

/** The task's open question is the one the message replies to, matched as answerLiveTask matches it. */
const isTaskQuestion = (task: TaskRecord, question: Message) =>
  task.question !== undefined && task.question.text === question.body && task.question.at === question.createdAt;

/**
 * Answer the question a live run waits on, as pacer answer does: the answer is reserved on the task's question
 * and typed into the running session, and the answer message is marked read so no later turn or live poll
 * delivers it again. The message is read before typing: while the answer is reserved the answer message may
 * not be claimed elsewhere, and a possibly-typed failure keeps it read. A delivery that typed nothing while the
 * session still waits rethrows and keeps it read, so only the caller's retry (same request id) delivers it — the
 * caller must never report it delivered. When the task moved on beneath the send (another answer, or its run changed),
 * returns false and the ordinary delivery below decides from the task as it is now.
 */
async function deliverLiveAnswer(ctx: Ctx, m: Message, target: string): Promise<boolean> {
  readMessages(ctx, m.to, [m.id]);
  try {
    await answerLiveTask(ctx, target, m.body);
  } catch (e) {
    // Possibly typed: answerLiveTask keeps the reservation on the task's question deliberately, so nothing
    // here may resend it; the failure reaches the caller.
    if (readTask(ctx, target)?.question?.answer === m.body) throw e;
    // A refused answer to the question the task waits on reaches the caller and stays read, so no later tick types it
    // behind the caller's back; only a reply that may still go out another way returns to pending.
    if (directAnswerTarget(ctx, m)) throw e;
    store.unmarkRead(ctx, m.to, [m.id]);
    return false;
  }
  return true;
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
  // A stale reply to an earlier question is never recorded as the answer of the question the task waits on now.
  if (!task?.question || task.question.answer !== undefined || !isTaskQuestion(task, question)) return { question };
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
  // A refused live answer stays read while its question stays open: a retry of the same request delivers it again.
  if (message.kind === "answer" && message.replyTo && directAnswerTarget(ctx, message)) {
    const { delivery, hold } = await deliverMessage(ctx, message, deps);
    return { message, duplicate: true, delivery, ...(hold ? { hold } : {}) };
  }
  // Another turn already took the answer, so its question is read.
  const answered = message.kind === "answer" && message.replyTo ? answeredQuestion(ctx, message.from, message.to, message.replyTo) : undefined;
  if (answered) readMessages(ctx, answered.to, [answered.id]);
  return { message, duplicate: true, delivery: "queued" };
}
