// Review gate for code steps. A code step in a run with a run branch is not done
// when its task settles: it waits (`waiting`, with its task and result) until the
// orchestrator or the person accepts the task, which merges it into the branch.
// Spec: "Accepting a run task merges, then accepts" and "Starting a task".
// Read helpers only; the engine owns the step transitions.
import { existsSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { readTask, updateTask } from "../tasks/store";
import { canContinue, TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import { isCodeStep, type WorkflowDef } from "./schema";
import {
  attachStepTask, branchOwner, fanoutAttempt, getDefinition, getRun, replaceRunConflicts,
  stepByTaskIfPresent, stepsOfRun, updateStep, workflowDatabase, type StepRow,
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

/** A conflicting merge the orchestrator cannot send back (the session does not
 *  resume): only the person can resolve it, so no turn is woken for it. */
export function waitsOnPerson(ctx: Ctx, runId: string, task: TaskRecord): boolean {
  return !!mergeConflictFor(ctx, runId, task.id) && !canContinue(ctx, task);
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
  if (!stepByTaskIfPresent(ctx, taskId)) return false;
  return workflowDatabase(ctx).transaction(() => {
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
}

/**
 * Drops the conflict markers a task's own accept raised and closes their records:
 * its new work supersedes the attempt that did not merge.
 */
export function clearTaskConflict(ctx: Ctx, taskId: string): void {
  const row = stepByTaskIfPresent(ctx, taskId);
  const run = row ? getRun(ctx, row.runId) : null;
  if (!run) return;
  const owner = branchOwner(ctx, run);
  const conflicts = owner.conflict ?? [];
  const mine = conflicts.filter(entry => entry.taskId === taskId);
  if (mine.length === 0) return;
  replaceRunConflicts(ctx, owner.id, conflicts.filter(entry => entry.taskId !== taskId));
  for (const entry of mine) closeConflictRecord(ctx, entry.resolutionTaskId);
}

/** Hides a conflict-resolution record nobody needs any more. */
export function closeConflictRecord(ctx: Ctx, resolutionTaskId: string): void {
  const record = readTask(ctx, resolutionTaskId);
  if (!record || record.review || record.dismissed) return;
  updateTask(ctx, resolutionTaskId, t => { t.dismissed = true; });
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
