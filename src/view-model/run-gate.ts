/** Workflow review-gate items and verdict results, in the words every surface uses. Framework-free. */
import type { AttentionItem } from "../attention/types";
import { mergeConflictStatus, taskStatus, type Status, type TaskStatusInput } from "./words";

/** What accepting does: an ordinary task, and a workflow code step. */
export const RECORD_ONLY_WORDS = "Accept records the verdict; you merge the branch.";
export const MERGE_ON_ACCEPT_WORDS = "Accepting merges the changes into the run branch.";

type Items = readonly AttentionItem[] | undefined;
const stepReviewStatus: Status = { label: "Waiting for review", tone: "info", glyph: "◐" };
/** The gate item about this task: a step under review or in conflict, or a branch conflict's record. */
export const gateFor = (attention: Items, taskId: string): AttentionItem | undefined =>
  attention?.find(item => item.gate && item.taskId === taskId);
/** The gate item whose conflict this task records. A record is not work: nothing runs it and it asks nothing. */
export const conflictRecordFor = (attention: Items, taskId: string): AttentionItem | undefined =>
  attention?.find(item => item.gate?.recordId === taskId);
/** A task's status in its lists and pages: what a gate holds up beats "completed",
 *  and a conflict record asks nothing. */
export function taskStatusIn(attention: Items, task: TaskStatusInput & { id: string }): Status {
  if (conflictRecordFor(attention, task.id) && task.state === "needs_input") return mergeConflictStatus;
  const gate = task.review ? undefined : gateFor(attention, task.id)?.gate?.kind;
  if (gate === "step_conflict") return mergeConflictStatus;
  if (gate === "step_review") return stepReviewStatus;
  return taskStatus(task);
}
/** The tasks of a run's steps whose merge conflicted. */
export const conflictedTasks = (attention: Items): Set<string> =>
  new Set((attention ?? []).flatMap(item => item.gate?.kind === "step_conflict" && item.taskId ? [item.taskId] : []));
/** What a run's gates ask of the person, in one line; null when none is open. */
export function runGateNote(runId: string, attention: Items): string | null {
  const kinds = new Set((attention ?? []).flatMap(item => item.gate && item.run?.id === runId ? [item.gate.kind] : []));
  if (kinds.has("step_conflict") || kinds.has("branch_conflict")) return "A merge conflict needs you";
  if (kinds.has("adoption")) return "The run is blocked";
  return kinds.has("step_review") ? "A review waits for you or the planner" : null;
}
export const acceptWords = (item: AttentionItem | undefined): string => item?.gate ? MERGE_ON_ACCEPT_WORDS : RECORD_ONLY_WORDS;
export const isConflictGate = (item: AttentionItem | undefined): boolean =>
  item?.gate?.kind === "step_conflict" || item?.gate?.kind === "branch_conflict";

/** A call that succeeded without doing what was asked, such as an accept that conflicts. */
export class OutcomeError extends Error {}

/** Why a call that answered successfully did nothing; null when it did what was asked. */
export function outcomeProblem(op: string, result: unknown): string | null {
  const r = result as { merge?: unknown; ok?: unknown } | null | undefined;
  if (!r || r.merge !== "conflict") return null;
  if (op === "task.review" || op === "dispatch.review") {
    return "Not accepted: the changes conflict with the run branch, so nothing was merged and no verdict was recorded. Send the task back to resolve it, or merge the run branch in its worktree and commit, then accept.";
  }
  if (op === "run.sync_base") {
    return "The update still conflicts, so nothing was merged. Resolve it with the commands on the conflict item, then accept the resolution.";
  }
  return null;
}

const SHORT: Record<string, string> = {
  "Send back to resolve": "Send back", "Try the update again": "Try again",
  "Accept the resolution": "Accept", "Open run": "Details",
};
/** A narrow surface's wording for a gate action, never a cut-off phrase. */
export const shortActionLabel = (label: string): string | undefined => Object.hasOwn(SHORT, label) ? SHORT[label] : undefined;
