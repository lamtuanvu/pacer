// Answers for a live interactive planner turn travel on the existing message lane
// (spec "Structured questions"). The answer's `question` wake-up is the one record
// of who still owes it: typing it into the session completes the wake-up, anything
// else leaves it open and the next turn carries it. The message is created only by
// the live session's poll, which records it in `workflow_live_answers`: a planner's
// terminal takes those messages and no other, whatever a sender writes.
import { resolveRunner } from "../config/runner-id";
import { loadStrategy } from "../config/strategy";
import { rootOf } from "../messaging/participants";
import * as messages from "../messaging/store";
import type { Message } from "../messaging/types";
import { readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { getQuestion, rootRunId, stepsOfRun, workflowDatabase, type QuestionRow } from "./store";
import { completeWakeupRef, liveTurnForTask, type TurnRow } from "./wakeups";

/** Whether pacer can type into this planner's interactive session: it must supervise
 *  the terminal itself and get the agent's turn-ended report. */
export function liveAnswerReachable(ctx: Ctx, planner: string): boolean {
  try {
    const strategy = loadStrategy(ctx);
    const runner = resolveRunner(strategy, planner);
    return !!runner && !runner.host && (runner.agent === "claude-code" || runner.agent === "codex")
      && ctx.env.PACER_BACKEND !== "orca" && strategy.execution?.backend !== "orca";
  } catch {
    return false;
  }
}

/** The planner's answered questions that were asked during this turn. */
function answeredInTurn(ctx: Ctx, turn: TurnRow): QuestionRow[] {
  if (!turn.taskId) return [];
  return workflowDatabase(ctx).query<{ id: string }, [string, number]>(
    `SELECT id FROM workflow_questions WHERE asker_task_id = ? AND asker_kind = 'orchestrator'
     AND status = 'answered' AND created_at >= ? ORDER BY created_at, id`,
  ).all(turn.taskId, turn.startedAt).flatMap(row => getQuestion(ctx, row.id) ?? []);
}

/** The answer's wake-up is still unclaimed: no turn and no delivery has taken it. */
function owed(ctx: Ctx, question: QuestionRow): boolean {
  return !!workflowDatabase(ctx).query(
    "SELECT 1 FROM workflow_wakeups WHERE run_id = ? AND cause = 'question' AND ref = ? AND done_at IS NULL AND turn_id IS NULL",
  ).get(rootRunId(ctx, question.runId), question.id);
}

function stepOf(ctx: Ctx, question: QuestionRow) {
  return stepsOfRun(ctx, question.runId).find(s => s.stepId === question.stepId
    && s.attempt === question.attempt && s.branch === question.branch);
}

/** A planner turn got an answer to a question it asked, delivered or still owed. */
export function turnWasAnswered(ctx: Ctx, turn: TurnRow): boolean {
  return answeredInTurn(ctx, turn).length > 0;
}

/** The planner task has a question open, or an answer nothing has delivered yet. */
export function awaitingRunAnswer(ctx: Ctx, taskId: string): boolean {
  return !!workflowDatabase(ctx).query(
    `SELECT 1 FROM workflow_questions q WHERE q.asker_task_id = ? AND q.asker_kind = 'orchestrator'
     AND (q.status = 'open' OR q.status = 'answered' AND EXISTS (SELECT 1 FROM workflow_wakeups w
       WHERE w.cause = 'question' AND w.ref = q.id AND w.done_at IS NULL AND w.turn_id IS NULL))`,
  ).get(taskId);
}

/** Whether the task is a run's planner task: it runs only inside an engine turn. */
export function isPlannerTask(ctx: Ctx, task: Pick<TaskRecord, "id" | "kind">): boolean {
  return task.kind === "orchestrate" && !!workflowDatabase(ctx).query(
    "SELECT 1 FROM workflow_runs WHERE orchestrator_task_id = ?",
  ).get(task.id);
}

const immediately = <T>(ctx: Ctx, write: () => T): T => workflowDatabase(ctx).transaction(write).immediate();

const closed = (ctx: Ctx, turnId: string): boolean =>
  !!workflowDatabase(ctx).query("SELECT 1 FROM workflow_live_closed WHERE turn_id = ?").get(turnId);

/** The planner task's live turn while its terminal may still take answers. */
export function liveAnswerTurn(ctx: Ctx, taskId: string): TurnRow | null {
  const turn = liveTurnForTask(ctx, taskId);
  return turn && !closed(ctx, turn.id) ? turn : null;
}

/** This turn's engine-created answer messages with their status. */
function liveAnswers(ctx: Ctx, turnId: string): { id: string; questionId: string; status: string }[] {
  messages.messagesDatabase(ctx);
  return workflowDatabase(ctx).query<{ id: string; question_id: string; status: string }, [string]>(
    `SELECT m.id, a.question_id, m.status FROM workflow_live_answers a
     JOIN messages m ON m.id = a.message_id WHERE a.turn_id = ? ORDER BY m.id`,
  ).all(turnId).map(row => ({ id: row.id, questionId: row.question_id, status: row.status }));
}

/**
 * Puts each answer the live turn is owed on the task's message lane, once per turn.
 * One transaction with the check that the turn is still open, so nothing is queued
 * after the turn closed.
 */
export function queueLiveAnswers(ctx: Ctx, task: TaskRecord): void {
  messages.messagesDatabase(ctx);
  immediately(ctx, () => {
    const turn = liveAnswerTurn(ctx, task.id);
    if (!turn) return;
    const queued = new Set(liveAnswers(ctx, turn.id).map(answer => answer.questionId));
    for (const q of answeredInTurn(ctx, turn)) {
      const status = stepOf(ctx, q)?.status;
      if (queued.has(q.id) || !owed(ctx, q) || status !== "running" && status !== "waiting") continue;
      const { message } = messages.insertMessage(ctx, {
        taskId: task.id, rootId: rootOf(ctx, `task:${task.id}`), from: "human", to: `task:${task.id}`, kind: "answer",
        body: JSON.stringify({ id: q.id, question: q.text, answer: q.answer }, null, 2),
        replyTo: null, requestId: null,
      });
      workflowDatabase(ctx).query("INSERT INTO workflow_live_answers(message_id, turn_id, question_id) VALUES (?, ?, ?)")
        .run(message.id, turn.id, q.id);
    }
  });
}

/** The messages a planner's terminal may be typed now: this turn's own pending answers. */
export function pendingLiveAnswers(ctx: Ctx, taskId: string): string[] {
  const turn = liveAnswerTurn(ctx, taskId);
  return turn ? liveAnswers(ctx, turn.id).filter(answer => answer.status === "pending").map(answer => answer.id) : [];
}

/** Claims this turn's pending answers for one delivery. */
export function claimLiveAnswers(ctx: Ctx, taskId: string, deliveryId: string): Message[] {
  return immediately(ctx, () =>
    messages.claimByIds(ctx, `task:${taskId}`, pendingLiveAnswers(ctx, taskId), deliveryId));
}

/** The messages just typed into the session: their answers are delivered, so no later turn owes them. */
export function confirmLiveAnswers(ctx: Ctx, taskId: string, typed: Message[]): void {
  immediately(ctx, () => {
    const turn = liveAnswerTurn(ctx, taskId);
    if (!turn) return;
    const ids = new Set(typed.map(m => m.id));
    for (const answer of liveAnswers(ctx, turn.id).filter(a => ids.has(a.id))) {
      const question = getQuestion(ctx, answer.questionId);
      if (question && owed(ctx, question)) completeWakeupRef(ctx, question.runId, "question", question.id);
      messages.markRead(ctx, `task:${taskId}`, [answer.id]);
    }
  });
}

/**
 * Ends the turn's use of the message lane: nothing of it stays pending or in flight, and
 * nothing more is queued for it. An answer that was typed but not confirmed (a failure
 * part-way) counts as delivered only when the planner went on to finish its step;
 * otherwise the next turn carries it.
 */
export function closeLiveAnswers(ctx: Ctx, turn: TurnRow, finished: boolean): void {
  const taskId = turn.taskId;
  if (!taskId) return;
  messages.messagesDatabase(ctx);
  immediately(ctx, () => {
    workflowDatabase(ctx).query("INSERT OR IGNORE INTO workflow_live_closed(turn_id) VALUES (?)").run(turn.id);
    for (const answer of liveAnswers(ctx, turn.id)) {
      if (answer.status === "read") continue;
      const question = getQuestion(ctx, answer.questionId);
      if (finished && answer.status === "delivered" && question && owed(ctx, question)
        && stepOf(ctx, question)?.status === "done") {
        completeWakeupRef(ctx, question.runId, "question", question.id);
      }
      messages.markRead(ctx, `task:${taskId}`, [answer.id]);
    }
  });
  const live = readTask(ctx, taskId)?.liveTurn;
  if (!live) return;
  messages.endTurn(ctx, live.id, "turn-ended", ctx.now);
  updateTask(ctx, taskId, t => { delete t.liveTurn; delete t.liveBlocked; delete t.liveError; });
}
