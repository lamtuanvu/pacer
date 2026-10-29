import type { TaskDetail } from "../../../../src/core/task-detail";
import { verdictParams } from "../review/model";

/** The service records a shell command as one check; splitting && would invent results. */
export function acceptanceRows(task: TaskDetail) {
  return task.acceptance.cmd ? [{cmd: task.acceptance.cmd, state: task.acceptance.state, output: task.acceptance.tail, durationS: task.acceptance.durationS}] : [];
}
export function reviewAvailable(task: TaskDetail): boolean {
  return !["queued", "running"].includes(task.state) && !task.review && !task.dismissed && !task.retriedBy;
}
export function retryRequest(task: TaskDetail, executor: string, note: string) {
  if (!task.work && note.trim() && executor !== (task.executor ?? task.attempts.at(-1)?.executor)) throw new Error("This service cannot pass feedback to a different executor. Edit the brief or choose the same executor.");
  return task.work
    ? {op: "dispatch.retry", params: {id: task.id, expect_rev: task.rev, requestId: `${task.id}.${task.rev}.retry`, feedback: note.trim()}}
    : {op: "task.review", params: verdictParams(task, note.trim() && executor === (task.executor ?? task.attempts.at(-1)?.executor) ? {verdict: "send_back", note} : {verdict: "retry", executor, note})};
}
