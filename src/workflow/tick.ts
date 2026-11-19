// Driving the engine from the shared task_changes log: a durable cursor walks the
// log page by page (taskChangesSince returns at most 500 rows, so the cursor only
// ever advances to the last fully handled change), every terminal change of a task
// that belongs to a step instance settles that step, and a gap in the log (pruned
// past, or a cursor ahead of a restored database) triggers a full rescan of running
// steps so no settlement is lost. A settlement error never propagates: transient
// SQLite lock errors stop the tick with the cursor at the last fully handled change
// and are retried next tick, at most five times per change before the change is
// treated as a deterministic failure; only deterministic errors fail the affected
// run, and one broken run cannot block every other run's settlement (Review Focus 3).
// Each tick also re-advances done steps whose outgoing edges were never processed
// (Review Focus: run correctness 4), and recovers settlements that a lock error
// lost at the exact point: a claimed failure whose failRun never landed, a fan-out
// whose branches are all settled without a join row, and a running step whose task
// is already terminal (Review Focus: run correctness 10).
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import type { TaskState } from "../tasks/types";
import { readTask } from "../tasks/store";
import { taskChangesSince } from "../tasks/changes";
import {
  attachStepTask, getCursor, getDefinition, getRun, listRuns, orphanSteps, setCursor, stepByTask, stepsOfRun,
  taskByRequestId, unadvancedDoneSteps, updateStep, type StepRow,
} from "./store";
import { defaultEngineDeps, failRun, joinFanout, onTaskSettled, readvanceStep, reconcileOrphanStep, stepRequestId, type EngineDeps } from "./engine";

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

/** Settles one step task: transient errors are retried on the next tick, but only
 *  a bounded number of times per change (Review Focus: run correctness 6) — after
 *  MAX_TRANSIENT_RETRIES attempts for the same task the change is treated as a
 *  deterministic failure. Deterministic errors are recorded on the run and swallowed
 *  so the batch keeps going; even recording the error must not break the batch, and
 *  a failing failRun must never block the cursor forever. */
const MAX_TRANSIENT_RETRIES = 5;
/** Transient retry counts, in memory per task id (Review Focus: run correctness 6);
 *  a successful or given-up settlement clears its entry. */
const transientRetries = new Map<string, number>();

async function settleOne(ctx: Ctx, taskId: string, runId: string | undefined, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<"settled" | "transient"> {
  try {
    await onTaskSettled(ctx, taskId, spawn, deps);
    transientRetries.delete(taskId);
    return "settled";
  } catch (err) {
    if (isTransientError(err)) {
      const count = (transientRetries.get(taskId) ?? 0) + 1;
      transientRetries.set(taskId, count);
      if (count <= MAX_TRANSIENT_RETRIES) return "transient";
      // The retry budget is spent: the same lock error every tick is a deterministic
      // failure of this change, not a reason to stop the tick forever.
      transientRetries.delete(taskId);
    }
    if (runId) {
      try {
        await failRun(ctx, runId, `engine error: ${err instanceof Error ? err.message : String(err)}`, undefined, deps);
        return "settled";
      } catch (failErr) {
        // A failing failRun must never block the cursor forever: the error is
        // recorded and the tick moves on to the next change (Review Focus 6).
        console.warn(`pacer: workflow tick could not fail run ${runId} after a settlement error: ${failErr instanceof Error ? failErr.message : String(failErr)}`);
        return "settled";
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

/** Re-advances done steps whose outgoing edges may never have been processed
 *  (advanced_at unset: a crash between marking the step done and advancing, or a
 *  run answer whose patch conflicted — Review Focus: run correctness 4). Rows older
 *  than 5 seconds only, so a settlement that its own caller is still advancing is
 *  never raced. A deferred end (Review Focus 5) whose busy siblings are gone ends
 *  the run here. */
async function readvanceStalled(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<RescanOutcome> {
  const stalled = unadvancedDoneSteps(ctx, ctx.now - 5);
  let handled = 0;
  for (const row of stalled) {
    try {
      if (await readvanceStep(ctx, row, spawn, deps)) handled++;
    } catch (err) {
      if (isTransientError(err)) return { handled, aborted: true };
      // A deterministic re-advance failure fails the run, like a failed start in
      // advanceFrom; a failing failRun leaves the row for the next tick.
      try { await failRun(ctx, row.runId, `re-advance failed: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
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

interface TickWalk { cursor: number; handled: number; stopped: boolean; rescanned: boolean }

/** Walks the change log from `from`, settling every terminal change of a task that
 *  belongs to a step instance, and persists the cursor at the last fully handled
 *  change. `stopped` is true when a gap rescan or a transient settlement error left
 *  work for the next tick. */
async function processChanges(ctx: Ctx, from: number, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<TickWalk> {
  let cursor = from;
  let handled = 0;
  for (;;) {
    const { changes, head, gap } = taskChangesSince(ctx, cursor);
    if (gap) {
      const outcome = await rescanRunningSteps(ctx, spawn, deps);
      saveCursor(ctx, head);
      return { cursor: head, handled: outcome.handled, stopped: outcome.aborted, rescanned: true };
    }
    if (changes.length === 0) {
      saveCursor(ctx, head);
      return { cursor: head, handled, stopped: false, rescanned: false };
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
      return { cursor, handled, stopped: true, rescanned: false };
    }
    saveCursor(ctx, cursor);
    if (cursor >= head) return { cursor, handled, stopped: false, rescanned: false };
  }
}

/** Recovers settlements a lock error lost at the exact point, in live runs only
 *  (Review Focus: run correctness 10):
 *  a. a non-branch step row with status failed and no advanced_at is a settlement
 *     that was claimed and whose failRun never landed — the run is failed and the
 *     row recorded advanced so the recovery does not repeat every tick;
 *  b. a fan-out attempt whose branches are all settled but which has no join row is
 *     joined (the branch settlement was claimed, then the join evaluation lost);
 *  c. a running step row whose task id is attached and whose task is already
 *     terminal (a settlement given up after its retry budget, or any missed change)
 *     is settled — cheaply: only rows of live runs, and only the task state.
 *  One broken run never blocks the others: per-run errors fail that run (or wait
 *  for the next tick when transient) and the loop moves on. */
async function recoverLostSettlements(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<number> {
  let handled = 0;
  for (const run of listRuns(ctx)) {
    if (run.status === "done" || run.status === "failed" || run.status === "stopped") continue;
    try {
      const rows = stepsOfRun(ctx, run.id);
      // (a) A claimed failure whose failRun never landed.
      const lostFailures = rows.filter(r => r.branch === undefined && r.status === "failed" && r.advancedAt === undefined);
      if (lostFailures.length > 0) {
        const first = lostFailures[0]!;
        await failRun(ctx, run.id, `step ${first.stepId} ${first.error ?? "failed"}`, undefined, deps);
        for (const row of lostFailures) {
          try { updateStep(ctx, { runId: run.id, stepId: row.stepId, attempt: row.attempt }, { advancedAt: ctx.now }); }
          catch { /* the row may have changed meanwhile; the run is terminal now anyway */ }
        }
        handled += lostFailures.length;
        continue; // the run is terminal now; the rest of the recovery does not apply
      }
      // (c) Settled tasks whose step row never claimed its settlement.
      let progressed = false;
      let transient = false;
      for (const row of rows) {
        if (row.status !== "running" || !row.taskId) continue;
        const task = readTask(ctx, row.taskId);
        if (!task || !SETTLE_STATES.includes(task.state)) continue;
        try {
          await onTaskSettled(ctx, row.taskId, spawn, deps);
          progressed = true;
        } catch (err) {
          if (isTransientError(err)) { transient = true; break; } // the next tick retries; the change loop owns the retry budget
          try { await failRun(ctx, run.id, `engine error: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
          catch { /* the next tick retries the row */ }
          break;
        }
      }
      if (transient) continue;
      if (progressed) handled++;
      // (b) Fan-out attempts whose branches are all settled without a join row.
      const current = getRun(ctx, run.id)!;
      if (current.status === "done" || current.status === "failed" || current.status === "stopped") continue;
      const fresh = progressed ? stepsOfRun(ctx, run.id) : rows;
      const def = getDefinition(ctx, `${current.workflow}@${current.version}`) ?? getDefinition(ctx, current.workflow);
      if (!def) continue;
      const attempts = new Map<string, { stepId: string; attempt: number; joined: boolean; branches: StepRow[] }>();
      for (const row of fresh) {
        const key = `${row.stepId}#${row.attempt}`;
        const attempt = attempts.get(key) ?? { stepId: row.stepId, attempt: row.attempt, joined: false, branches: [] };
        if (row.branch === undefined) attempt.joined = true;
        else attempt.branches.push(row);
        attempts.set(key, attempt);
      }
      for (const attempt of attempts.values()) {
        if (attempt.joined || attempt.branches.length === 0) continue;
        if (attempt.branches.some(b => b.status === "running" || b.status === "waiting")) continue;
        const stepDef = def.steps[attempt.stepId];
        if (stepDef?.type !== "fanout") continue;
        try {
          await joinFanout(ctx, current, def, attempt.branches[0]!, stepDef, { deps, spawn });
          handled++;
        } catch (err) {
          // A concurrent join (the change loop, say) may have inserted the join row
          // first: its UNIQUE conflict is the join already resolved, not a failure.
          const joined = stepsOfRun(ctx, run.id).some(j => j.branch === undefined && j.stepId === attempt.stepId && j.attempt === attempt.attempt);
          if (!joined) throw err;
        }
      }
    } catch (err) {
      // Transient errors retry next tick; deterministic ones fail the run like any
      // settlement error, and a failing failRun leaves the run for the next tick.
      if (isTransientError(err)) continue;
      try { await failRun(ctx, run.id, `recovery failed: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
      catch { /* the next tick retries */ }
    }
  }
  return handled;
}

export async function advanceRuns(ctx: Ctx, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<{ handled: number; rescanned: boolean }> {
  let handled = 0;
  // Orphan reconciliation first, on every tick (not only after a gap): a recovered
  // step may then also have its own change waiting in the log below, which is a no-op.
  const orphans = await reconcileOrphans(ctx, spawn, deps);
  if (orphans.aborted) return { handled: orphans.handled, rescanned: false };
  handled += orphans.handled;
  // Then the stalled advancements (Review Focus: run correctness 4): a step that is
  // done but was never advanced gets its edges replayed, and a deferred end whose
  // siblings are gone finally ends the run.
  const stalled = await readvanceStalled(ctx, spawn, deps);
  if (stalled.aborted) return { handled: handled + stalled.handled, rescanned: false };
  handled += stalled.handled;
  const walk = await processChanges(ctx, getCursor(ctx), spawn, deps);
  handled += walk.handled;
  // Recovery last: the change loop settles what the log still holds; the recovery
  // then repairs what a lock error took out of it (Review Focus: run correctness 10).
  // It is skipped when the walk stopped early (a transient or an aborted rescan):
  // the next tick re-processes the log first, then recovers.
  if (!walk.stopped) handled += await recoverLostSettlements(ctx, spawn, deps);
  return { handled, rescanned: walk.rescanned };
}
