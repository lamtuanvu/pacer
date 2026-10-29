import type { TaskDetail } from "../../../src/core/task-detail";

type AnswerTask = Pick<TaskDetail, "work" | "state" | "question" | "retriedBy" | "dismissed" | "messages" | "review">;
/** A question asked with `pacer ask`: the task records it, and task.answer answers it. */
export function legacyQuestionPending(task: AnswerTask): boolean {
  return !task.work && task.state === "needs_input" && !!task.question && task.question.answer === undefined && !task.retriedBy && !task.dismissed;
}
/**
 * The unread question a task sent the human, unless the legacy composer already answers it.
 * A reviewed, dismissed or stopped task is closed for messages, so it has nothing to answer.
 */
export function messageQuestion(task: AnswerTask): { id: string; text: string } | undefined {
  const question = task.messages?.question;
  return question && !task.dismissed && !task.review && task.state !== "stopped" && !legacyQuestionPending(task) ? question : undefined;
}
/** The msg.send answer to a task's question; the request id makes a repeated click send once. */
export const answerParams = (taskId: string, questionId: string, body: string, requestId: string) =>
  ({ to: `task:${taskId}`, kind: "answer" as const, reply_to: questionId, body: body.trim(), request_id: requestId });
