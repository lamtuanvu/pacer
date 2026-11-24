// Run priority → dispatcher numeric task priority (Phase 6 Task 1).
// Scale confirmed on main: workOptionsSchema.priority is int −100…100, default 0
// (src/dispatch/work.ts). Drain sorts queued tasks by that value descending
// (src/tasks/drain.ts).
import type { Ctx } from "../types";
import { boundedJson, dispatchDatabase } from "../dispatch/store";
import { getWork, workOptionsSchema, type WorkOptions } from "../dispatch/work";
import { readTask } from "../tasks/store";
import { stepsOfRun, type RunRow } from "./store";

export const RUN_PRIORITIES = ["urgent", "normal", "background"] as const;
export type RunPriority = (typeof RUN_PRIORITIES)[number];

/** Dispatcher scale extremes and default (see workOptionsSchema). */
export const TASK_PRIORITY = {
  urgent: 100,
  normal: 0,
  background: -100,
} as const satisfies Record<RunPriority, number>;

export function isRunPriority(value: unknown): value is RunPriority {
  return typeof value === "string" && (RUN_PRIORITIES as readonly string[]).includes(value);
}

export function taskPriorityFor(priority: RunPriority | undefined | null): number {
  return TASK_PRIORITY[priority ?? "normal"];
}

export function runPriorityOf(run: Pick<RunRow, "priority"> | null | undefined): RunPriority {
  return run?.priority ?? "normal";
}

/**
 * Dispatch fields for a step delegate, or undefined so plain-mode steps stay
 * unmanaged at every priority (priority is still recorded on the run; pacing
 * still applies). Include `requirements` (schema default) so meetsRequirements
 * does not see `undefined`, but do **not** pass other schema defaults
 * (`allowDelegation`, `maxConcurrent`, …) — registerWork treats those as
 * explicit overrides and would otherwise block parent inheritance.
 */
export function stepDispatchOptions(
  priority: number,
  workNode: boolean,
): WorkOptions | undefined {
  if (!workNode) return undefined;
  const defaults = workOptionsSchema.parse({});
  // Runtime object has only these keys so registerWork inheritance still applies.
  return { priority, requirements: defaults.requirements } as WorkOptions;
}

/** Rewrite `options.priority` on an existing work node (no-op when missing). */
export function setWorkNodePriority(ctx: Ctx, taskId: string, priority: number): boolean {
  const work = getWork(ctx, taskId);
  if (!work) return false;
  if (work.options.priority === priority) return false;
  const options = { ...work.options, priority };
  dispatchDatabase(ctx).query(
    "UPDATE work_nodes SET options = ? WHERE task_id = ?",
  ).run(boundedJson(options), taskId);
  return true;
}

/**
 * Apply a run's mapped priority to its QUEUED step tasks only (not running /
 * terminal). Ordinary tasks outside the run are never touched. Engine-owned
 * workflow-root / orchestrate tasks are skipped.
 */
export function applyPriorityToQueuedRunTasks(ctx: Ctx, run: RunRow): string[] {
  const mapped = taskPriorityFor(runPriorityOf(run));
  const updated: string[] = [];
  for (const step of stepsOfRun(ctx, run.id)) {
    if (!step.taskId) continue;
    const task = readTask(ctx, step.taskId);
    if (!task || task.state !== "queued") continue;
    if (task.kind === "workflow-root" || task.kind === "orchestrate") continue;
    if (setWorkNodePriority(ctx, step.taskId, mapped)) updated.push(step.taskId);
  }
  return updated;
}
