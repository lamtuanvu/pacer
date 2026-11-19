// Driving the engine from the shared task_changes log: a durable cursor walks the
// log, every terminal change of a task that belongs to a step instance settles that
// step, and a gap in the log (pruned past, or a cursor ahead of a restored
// database) triggers a full rescan of running steps so no settlement is lost. A
// settlement error never propagates: the affected run is failed (when the change
// still points at one) and the cursor always advances to head, so one broken run
// cannot block every other run's settlement (Review Focus 3).
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import type { TaskState } from "../tasks/types";
import { taskChangesSince } from "../tasks/changes";
import { getCursor, listRuns, setCursor, stepByTask, stepsOfRun } from "./store";
import { defaultEngineDeps, failRun, onTaskSettled, type EngineDeps } from "./engine";

const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];

/** Settles one step task: an unexpected error is recorded on the run and swallowed
 *  so the batch keeps going; even recording the error must not break the batch. */
async function settleOne(ctx: Ctx, taskId: string, runId: string | undefined, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<void> {
  try {
    await onTaskSettled(ctx, taskId, spawn, deps);
  } catch (err) {
    if (runId) {
      try { failRun(ctx, runId, `engine error: ${err instanceof Error ? err.message : String(err)}`); }
      catch { /* the batch continues regardless */ }
    }
  }
}

export async function advanceRuns(ctx: Ctx, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<{ handled: number; rescanned: boolean }> {
  const cursor = getCursor(ctx);
  const { changes, head, gap } = taskChangesSince(ctx, cursor);
  let handled = 0;
  if (gap) {
    for (const run of listRuns(ctx)) {
      for (const row of stepsOfRun(ctx, run.id)) {
        if (row.status !== "running" || !row.taskId) continue;
        await settleOne(ctx, row.taskId, row.runId, spawn, deps);
        handled++;
      }
    }
  } else {
    for (const change of changes) {
      if (!SETTLE_STATES.includes(change.state)) continue;
      const step = stepByTask(ctx, change.taskId);
      if (!step) continue;
      await settleOne(ctx, change.taskId, step.runId, spawn, deps);
      handled++;
    }
  }
  setCursor(ctx, head);
  return { handled, rescanned: gap };
}
