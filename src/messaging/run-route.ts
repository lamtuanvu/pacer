// Run-participant messaging route (ADR 0011 amendment / ADR 0029): resolve
// participation only from stored workflow rows, never from caller-supplied markers.
import type { Ctx } from "../types";
import { isEngineOwnedKind } from "../tasks/engine-owned";
import { readTask } from "../tasks/store";
import { taskOf } from "./participants";
import {
  getRun,
  stepByTaskIfPresent,
  workflowSchemaPresent,
} from "../workflow/store";

const TERMINAL = new Set(["done", "failed", "stopped"]);

/**
 * The run id a participant belongs to, or null when they are not a run participant.
 * Fail closed when workflow tables are absent. A task is a participant when it has
 * a step row on a live run. Engine-owned orchestrate / workflow-root tasks are
 * excluded so settled orchestrator tasks are not resumed as generic message turns.
 * Never forge participation from PACER_TASK_ID or participant name "orchestrator".
 */
export function runIdForParticipant(ctx: Ctx, participant: string): string | null {
  if (!workflowSchemaPresent(ctx)) return null;
  const taskId = taskOf(participant);
  if (!taskId) return null;
  const task = readTask(ctx, taskId);
  if (task && isEngineOwnedKind(task.kind)) return null;
  const step = stepByTaskIfPresent(ctx, taskId);
  if (!step) return null;
  const run = getRun(ctx, step.runId);
  if (!run || TERMINAL.has(run.status)) return null;
  return step.runId;
}

/** True when both sides resolve to run participants from stored rows. */
export function bothRunParticipants(ctx: Ctx, from: string, to: string): boolean {
  return !!runIdForParticipant(ctx, from) && !!runIdForParticipant(ctx, to);
}
