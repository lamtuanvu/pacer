// Review gate for code steps. A code step in a run with a run branch is not done
// when its task settles: it waits (`waiting`, with its task and result) until the
// orchestrator or the person accepts the task, which merges it into the branch.
// Spec: "Accepting a run task merges, then accepts" and "Starting a task".
// Read helpers only; the engine owns the step transitions.
import { existsSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { readTask } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import { isCodeStep, type WorkflowDef } from "./schema";
import { branchOwner, getDefinition, getRun, stepByTaskIfPresent, type StepRow } from "./store";

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

/**
 * Refuse a code step's report while its worktree has uncommitted tracked changes,
 * so the agent commits in the same turn. Accepting the task checks again, with
 * untracked files; a git failure here is left to that check.
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
  const status = await ctx.run(["git", "-C", task.worktree, "status", "--porcelain", "--untracked-files=no"], 15_000);
  if (status.code === 0 && status.stdout.trim()) {
    throw new CoreError(
      "invalid_input",
      "uncommitted changes in the task worktree: commit them on the task branch, then report the step result again",
    );
  }
}
