// Driving the engine from the shared task_changes log: a durable cursor walks the
// log, every terminal change of a task that belongs to a step instance settles that
// step, and a gap in the log (pruned past, or a cursor ahead of a restored
// database) triggers a full rescan of running steps so no settlement is lost. The
// cursor only advances after the batch is handled, so a throw replays it next tick
// and idempotency keeps the replay from starting a step twice (Review Focus 3).
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import type { TaskState } from "../tasks/types";
import { taskChangesSince } from "../tasks/changes";
import { getCursor, listRuns, setCursor, stepByTask, stepsOfRun } from "./store";
import { defaultEngineDeps, onTaskSettled, type EngineDeps } from "./engine";

const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];

export async function advanceRuns(ctx: Ctx, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<{ handled: number; rescanned: boolean }> {
  const cursor = getCursor(ctx);
  const { changes, head, gap } = taskChangesSince(ctx, cursor);
  let handled = 0;
  if (gap) {
    for (const run of listRuns(ctx)) {
      for (const row of stepsOfRun(ctx, run.id)) {
        if (row.status !== "running" || !row.taskId) continue;
        await onTaskSettled(ctx, row.taskId, spawn, deps);
        handled++;
      }
    }
  } else {
    for (const change of changes) {
      if (!SETTLE_STATES.includes(change.state)) continue;
      if (!stepByTask(ctx, change.taskId)) continue;
      await onTaskSettled(ctx, change.taskId, spawn, deps);
      handled++;
    }
  }
  setCursor(ctx, head);
  return { handled, rescanned: gap };
}
