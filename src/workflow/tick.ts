// Driving the engine from the shared task_changes log: a durable cursor walks the
// log page by page (taskChangesSince returns at most 500 rows, so the cursor only
// ever advances to the last fully handled change), every terminal change of a task
// that belongs to a step instance settles that step, and a gap in the log (pruned
// past, or a cursor ahead of a restored database) triggers a full rescan of running
// steps so no settlement is lost. A settlement error never propagates: transient
// SQLite lock errors stop the tick with the cursor at the last fully handled change
// and are retried next tick, only deterministic errors fail the affected run, and
// one broken run cannot block every other run's settlement (Review Focus 3).
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import type { TaskState } from "../tasks/types";
import { taskChangesSince } from "../tasks/changes";
import { attachStepTask, getCursor, listRuns, orphanSteps, setCursor, stepByTask, stepsOfRun, taskByRequestId, type StepRow } from "./store";
import { defaultEngineDeps, failRun, onTaskSettled, reconcileOrphanStep, stepRequestId, type EngineDeps } from "./engine";
import type { StepRow } from "./store";

const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];

/** SQLite lock contention (SQLITE_BUSY and its messages, including the busy-timeout
 *  expiry) is transient: the tick stops and retries next time instead of failing a
 *  run over a lock another connection still holds. */
export function isTransientError(err: unknown): boolean {
  const text = `${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  return text.includes("sqlite_busy") || text.includes("database is locked")
    || text.includes("database table is locked") || text.includes("database is busy")
    || text.includes("database schema is locked");
}

/** Settles one step task: transient errors report back so the tick can stop and
 *  retry, deterministic errors are recorded on the run and swallowed so the batch
 *  keeps going; even recording the error must not break the batch. */
async function settleOne(ctx: Ctx, taskId: string, runId: string | undefined, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<"settled" | "transient"> {
  try {
    await onTaskSettled(ctx, taskId, spawn, deps);
    return "settled";
  } catch (err) {
    if (isTransientError(err)) return "transient";
    if (runId) {
      try {
        await failRun(ctx, runId, `engine error: ${err instanceof Error ? err.message : String(err)}`, undefined, deps);
        return "settled";
      } catch (failErr) {
        // A failing failRun leaves the change unhandled: the cursor stays and the
        // next tick retries, whatever the failure was.
        void failErr;
        return "transient";
      }
    }
    return "settled";
  }
}

interface RescanOutcome { handled: number; aborted: boolean }

/** Reconciles orphan step rows (status running, no task id) on every tick, not only
 *  after a cursor gap (Review Focus: run correctness 2): a task reserved under the
 *  row's request id is attached and settled, and a row older than 60 seconds without
 *  a task is delegated again under the same attempt and request id. With no orphans
 *  this is one cheap indexed query. */
async function reconcileOrphans(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<RescanOutcome> {
  const orphans = orphanSteps(ctx);
  let handled = 0;
  for (const row of orphans) {
    try {
      const outcome = await reconcileOrphanStep(ctx, row, spawn, deps);
      if (outcome === "attached" || outcome === "redelegated") handled++;
    } catch (err) {
      if (isTransientError(err)) return { handled, aborted: true };
      // A deterministic re-delegation failure fails the run, like a failed start in
      // advanceFrom; a failing failRun leaves the row for the next tick.
      try { await failRun(ctx, row.runId, `re-delegate failed: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
      catch { /* the next tick retries the row */ }
    }
  }
  return { handled, aborted: false };
}

/** Persists the cursor; a lock failure only delays it, since settlements are idempotent. */
function saveCursor(ctx: Ctx, seq: number): void {
  try { setCursor(ctx, seq); } catch { /* the next tick retries from the last saved seq */ }
}

/** Full reconcile after a cursor gap: every running step is settled from its task,
 *  and step rows written before their delegation attach the task their request id
 *  reserved. */
async function rescanRunningSteps(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<RescanOutcome> {
  let handled = 0;
  for (const run of listRuns(ctx)) {
    for (const row of stepsOfRun(ctx, run.id)) {
      if (row.status !== "running") continue;
      let taskId = row.taskId;
      if (!taskId) {
        const prior = taskByRequestId(ctx, stepRequestId(run.id, row.stepId, row.attempt, row.branch));
        if (!prior) continue; // the delegation may still be pending: nothing to attach
        const key = { runId: run.id, stepId: row.stepId, attempt: row.attempt, ...(row.branch !== undefined ? { branch: row.branch } : {}) };
        try { attachStepTask(ctx, key, prior.id); } catch (err) {
          if (isTransientError(err)) return { handled, aborted: true };
          continue;
        }
        taskId = prior.id;
        handled++;
      }
      const outcome = await settleOne(ctx, taskId, run.id, spawn, deps);
      if (outcome === "transient") return { handled, aborted: true };
      handled++;
    }
  }
  return { handled, aborted: false };
}

export async function advanceRuns(ctx: Ctx, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<{ handled: number; rescanned: boolean }> {
  let cursor = getCursor(ctx);
  let handled = 0;
  // Orphan reconciliation first, on every tick (not only after a gap): a recovered
  // step may then also have its own change waiting in the log below, which is a no-op.
  const orphans = await reconcileOrphans(ctx, spawn, deps);
  if (orphans.aborted) return { handled: handled + orphans.handled, rescanned: false };
  handled += orphans.handled;
  for (;;) {
    const { changes, head, gap } = taskChangesSince(ctx, cursor);
    if (gap) {
      const outcome = await rescanRunningSteps(ctx, spawn, deps);
      if (outcome.aborted) return { handled: handled + outcome.handled, rescanned: true };
      saveCursor(ctx, head);
      return { handled: handled + outcome.handled, rescanned: true };
    }
    if (changes.length === 0) {
      saveCursor(ctx, head);
      return { handled, rescanned: false };
    }
    let transient = false;
    for (const change of changes) {
      if (!SETTLE_STATES.includes(change.state)) { cursor = change.seq; continue; }
      const step = stepByTask(ctx, change.taskId);
      if (!step) { cursor = change.seq; continue; }
      const outcome = await settleOne(ctx, change.taskId, step.runId, spawn, deps);
      if (outcome === "transient") { transient = true; break; }
      cursor = change.seq;
      handled++;
    }
    if (transient) {
      // The cursor stays at the last fully handled change; the rest is next tick's work.
      // The write itself may hit the same lock: the next tick then retries unchanged.
      saveCursor(ctx, cursor);
      return { handled, rescanned: false };
    }
    saveCursor(ctx, cursor);
    if (cursor >= head) return { handled, rescanned: false };
  }
}
