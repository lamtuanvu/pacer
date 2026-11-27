// Review gate for code steps. A code step in a run with a run branch is not done
// when its task settles: it waits (`waiting`, with its task and result) until the
// orchestrator or the person accepts the task, which merges it into the branch.
// Spec: "Accepting a run task merges, then accepts" and "Starting a task".
// Read helpers only; the engine owns the step transitions.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { getWork } from "../dispatch/work";
import { readTask, updateTask } from "../tasks/store";
import { canContinue, TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import { isCodeStep, type WorkflowDef } from "./schema";
import {
  attachStepTask, branchOwner, fanoutAttempt, getDefinition, getRun, liveRuns, removeRunConflicts, replaceRunConflicts,
  runsSharingBranch, stepByTaskIfPresent, stepsOfRun, updateStep, workflowDatabase, workflowSchemaPresent, type RunConflict, type RunRow, type StepRow,
} from "./store";

/** Whether the row's step is an agent or fan-out branch step that changes code. */
export function isCodeRow(def: WorkflowDef, row: StepRow): boolean {
  const step = def.steps[row.stepId];
  if (step?.type === "agent") return isCodeStep(step);
  if (step?.type === "fanout") return row.branch !== undefined && isCodeStep(step.each);
  return false;
}

function definitionOf(ctx: Ctx, runId: string): WorkflowDef | null {
  const run = getRun(ctx, runId);
  if (!run) return null;
  return getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
}

/** Whether a settled task of this row must be reviewed before the run moves on. */
export function needsReview(ctx: Ctx, def: WorkflowDef, row: StepRow): boolean {
  const run = getRun(ctx, row.runId);
  return !!run && isCodeRow(def, row) && !!branchOwner(ctx, run).branch;
}

/** A row parked for review. Other waiting rows (human, choose, generate) have no
 *  task, and orchestrator-role steps are never code steps. */
export function awaitsReview(ctx: Ctx, row: StepRow, def?: WorkflowDef | null): boolean {
  if (row.status !== "waiting" || !row.taskId || row.result === undefined) return false;
  const definition = def ?? definitionOf(ctx, row.runId);
  return !!definition && isCodeRow(definition, row);
}

/** The conflict-resolution task blocking this task's merge, when there is one. */
export function mergeConflictFor(ctx: Ctx, runId: string, taskId: string): string | undefined {
  const run = getRun(ctx, runId);
  if (!run) return undefined;
  return branchOwner(ctx, run).conflict?.find(entry => entry.taskId === taskId)?.resolutionTaskId;
}

/** Whether a send-back can still continue the task: its session resumes, and
 *  managed work has an attempt left (a continuation is a new attempt). */
export function canSendBack(ctx: Ctx, task: TaskRecord): boolean {
  const work = getWork(ctx, task.id);
  return canContinue(ctx, task) && !task.dismissed && !removedWorktree(task)
    && !(work && task.attempts.length >= (work.options.maxAttempts ?? 3));
}

/** The task's own worktree when it is gone from this machine. */
export function removedWorktree(task: TaskRecord): string | undefined {
  const path = task.worktree ?? task.result?.worktree;
  return path && !task.run?.host && !existsSync(path) ? path : undefined;
}

/** Whether a workflow review is waiting on this task: a step's changes without a
 *  verdict (also while sent back), or an open conflict and its record. */
export function reviewHolds(ctx: Ctx, taskId: string): boolean {
  if (!workflowSchemaPresent(ctx)) return false;
  const task = readTask(ctx, taskId);
  if (!task || task.review || task.retriedBy) return false;
  const row = stepByTaskIfPresent(ctx, taskId);
  if (row && !["failed", "stopped", "limit"].includes(task.state) && awaitsReview(ctx, row)) {
    const status = getRun(ctx, row.runId)?.status;
    if (status === "running" || status === "waiting") return true;
  }
  return liveRuns(ctx).some(run => run.conflict?.some(entry => entry.taskId === taskId || entry.resolutionTaskId === taskId));
}

/** A held task is neither dismissed nor cleaned up: that would leave its review nothing to act on. */
export function assertDismissable(ctx: Ctx, taskId: string): void {
  if (reviewHolds(ctx, taskId)) {
    throw new CoreError("not_allowed", `${taskId} cannot be dismissed: a workflow review is waiting on it. Accept, reject or send it back first.`);
  }
}

/** Why a held task's session cannot be resumed, with what still works; null when it can be tried. */
export function resumeBlocked(ctx: Ctx, task: TaskRecord): string | null {
  const why = task.dismissed ? "it was dismissed" : removedWorktree(task) ? "its worktree was removed" : null;
  if (!why || !reviewHolds(ctx, task.id)) return null;
  return `Not sent back: ${task.id} cannot resume because ${why}. Nothing changed. Accept it (resolve any conflict by hand first), or reject it and retry the step.`;
}

/** A conflicting merge the orchestrator cannot send back: only the person can resolve it, so no turn is woken for it. */
export function waitsOnPerson(ctx: Ctx, runId: string, task: TaskRecord): boolean {
  return !!mergeConflictFor(ctx, runId, task.id) && !canSendBack(ctx, task);
}

/** The task a parked row is waiting on a verdict for, or null when nobody owes one
 *  now (reviewed, retried, resumed for a follow-up, or ended without success). */
export function reviewDueTask(ctx: Ctx, row: StepRow, def?: WorkflowDef | null): TaskRecord | null {
  if (!awaitsReview(ctx, row, def)) return null;
  const task = readTask(ctx, row.taskId!);
  if (!task || (task.state !== "done" && task.state !== "partial") || task.review || task.retriedBy) return null;
  return task;
}

/** The task was resumed (send-back or message) after its step parked for review,
 *  so the agent may report the step again. */
export function resumedForFollowUp(ctx: Ctx, row: StepRow): boolean {
  if (!awaitsReview(ctx, row)) return false;
  const task = readTask(ctx, row.taskId!);
  return !!task && !TERMINAL_STATES.includes(task.state);
}

/** Error prefix of a step the review gate failed: a verdict, or its task ending
 *  badly while it waited for one. */
export const REVIEW_REJECTED = "review rejected";

/** A fan-out branch the review gate failed. It holds its join until the branch is
 *  retried or skipped, instead of failing the fan-out outright. */
export function isHeldBranch(row: StepRow): boolean {
  return row.branch !== undefined && row.status === "failed" && !!row.error?.startsWith("review");
}

/** Whether the fan-out attempt `row` belongs to already has its join row. */
export function fanoutJoined(rows: StepRow[], row: StepRow): boolean {
  const attempt = fanoutAttempt(row);
  return rows.some(j => j.branch === undefined && j.stepId === row.stepId && j.attempt === attempt);
}

/**
 * A retry of a step's task takes the step over, so it can report and its work is
 * reviewed and merged like the first attempt's. Called inside the retry's commit,
 * before the new task can run. Only a running or parked step moves.
 */
export function adoptRetriedStep(ctx: Ctx, taskId: string, successorId: string): boolean {
  const runId = stepByTaskIfPresent(ctx, taskId)?.runId;
  if (!runId) return false;
  const moved = workflowDatabase(ctx).transaction(() => {
    const row = stepByTaskIfPresent(ctx, taskId);
    if (!row || (row.status !== "running" && !awaitsReview(ctx, row))) return false;
    const run = getRun(ctx, row.runId);
    if (!run || run.status === "done" || run.status === "failed" || run.status === "stopped") return false;
    // Only the live attempt of the step moves; an older row is history.
    if (stepsOfRun(ctx, row.runId).some(s =>
      s.stepId === row.stepId && s.branch === row.branch && s.attempt > row.attempt)) return false;
    const key = {
      runId: row.runId, stepId: row.stepId, attempt: row.attempt,
      ...(row.branch !== undefined ? { branch: row.branch } : {}),
    };
    attachStepTask(ctx, key, successorId);
    updateStep(ctx, key, { status: "running", result: null });
    return true;
  }).immediate();
  if (moved) pruneAbandonedConflicts(ctx, runId);
  return moved;
}

/**
 * Drops the conflict markers a task's own accept raised and closes their records:
 * its new work supersedes the attempt that did not merge.
 */
export function clearTaskConflict(ctx: Ctx, taskId: string): void {
  const row = stepByTaskIfPresent(ctx, taskId);
  const run = row ? getRun(ctx, row.runId) : null;
  if (!run) return;
  const dropped = removeRunConflicts(ctx, branchOwner(ctx, run).id, entry => entry.taskId === taskId);
  for (const entry of dropped) closeConflictRecord(ctx, entry.resolutionTaskId);
}

/** Whether a task was started for a workflow step (itself, or the task it retries). */
function startedForStep(ctx: Ctx, taskId: string): boolean {
  const seen = new Set<string>();
  for (let id: string | undefined = taskId; id && !seen.has(id);) {
    seen.add(id);
    const task: TaskRecord | null = readTask(ctx, id);
    if (task?.requestId?.startsWith("wf:")) return true;
    id = task?.retryOf;
  }
  return false;
}

/**
 * Whether the work of a conflicting task was given up: the task was rejected or
 * retried, or the step that held it when the merge conflicted has since failed,
 * been skipped or been stopped. A conflict raised by accepting a task whose step
 * had already ended, or that no step holds, is the person's own and stays until
 * they reject or retry that task.
 */
function abandoned(ctx: Ctx, owner: RunRow, entry: RunConflict): boolean {
  const { taskId } = entry;
  // A record that never was a step's task goes with the marker it resolves.
  if (/^(base|child):/.test(taskId) || !startedForStep(ctx, taskId)) return false;
  const task = readTask(ctx, taskId);
  if (task?.review?.accepted === false || task?.retriedBy) return true;
  if (entry.live === false) return false;
  const rows = runsSharingBranch(ctx, owner)
    .flatMap(run => stepsOfRun(ctx, run.id))
    .filter(row => row.taskId === taskId);
  return rows.length > 0 && rows.every(row => row.status === "failed" || row.status === "stopped"
    || (row.status === "done" && (row.result as { skipped?: unknown } | undefined)?.skipped === true));
}

/**
 * Drops the conflict markers, and closes their records, of work that will never be
 * accepted. A marker keeps publishing closed, so one that outlives its work would
 * block the run for good. Safe to call at any point.
 */
export function pruneAbandonedConflicts(ctx: Ctx, runId: string): void {
  const run = getRun(ctx, runId);
  if (!run) return;
  const ownerId = branchOwner(ctx, run).id;
  // Read and replace in one transaction: a conflict raised meanwhile is not lost.
  const dropped = workflowDatabase(ctx).transaction(() => {
    const owner = getRun(ctx, ownerId)!;
    let kept = owner.conflict ?? [];
    const gone: RunConflict[] = [];
    for (;;) {
      const now = kept.filter(entry => abandoned(ctx, owner, entry)
        || gone.some(d => d.resolutionTaskId === entry.taskId));
      if (now.length === 0) break;
      gone.push(...now);
      kept = kept.filter(entry => !now.includes(entry));
    }
    if (gone.length > 0) replaceRunConflicts(ctx, ownerId, kept);
    return gone;
  }).immediate();
  for (const entry of dropped) closeConflictRecord(ctx, entry.resolutionTaskId);
}

/** Hides a conflict-resolution record nobody needs any more. */
export function closeConflictRecord(ctx: Ctx, resolutionTaskId: string): void {
  const record = readTask(ctx, resolutionTaskId);
  if (!record || record.review || record.dismissed) return;
  // Settled as well as hidden: wherever it is still listed it must not read as a question.
  updateTask(ctx, resolutionTaskId, t => { t.dismissed = true; if (t.state === "needs_input") t.state = "stopped"; });
}

/**
 * Refuse a code step's report while its worktree has uncommitted or untracked
 * files, so the agent commits (or removes) them in the same turn: accepting the
 * task refuses exactly the same. A git failure here is left to that check.
 */
export async function assertStepCommitted(ctx: Ctx, taskId: string): Promise<void> {
  const row = stepByTaskIfPresent(ctx, taskId);
  if (!row || (row.status !== "running" && row.status !== "waiting")) return;
  const def = definitionOf(ctx, row.runId);
  if (!def || !needsReview(ctx, def, row)) return;
  const task = readTask(ctx, taskId);
  if (!task || task.run?.host || !task.worktree || !existsSync(task.worktree)) return;
  const [tree, repo] = await Promise.all([gitInfo(ctx.run, task.worktree), gitInfo(ctx.run, task.brief.repo)]);
  if ("error" in tree || "error" in repo || realpathSafe(tree.top) === realpathSafe(repo.top)) return;
  const status = await ctx.run(["git", "-C", task.worktree, "status", "--porcelain"], 15_000);
  if (status.code === 0 && status.stdout.trim()) {
    throw new CoreError(
      "invalid_input",
      "uncommitted changes in the task worktree: commit them on the task branch (or remove stray files), then report the step result again",
    );
  }
}
