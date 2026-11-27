// Driving the engine from the shared task_changes log: a durable cursor walks the
// log page by page (taskChangesSince returns at most 500 rows, so the cursor only
// ever advances to the last fully handled change), every terminal change of a task
// that belongs to a step instance settles that step, and a gap in the log (pruned
// past, or a cursor ahead of a restored database) triggers a full rescan of running
// steps so no settlement is lost. A settlement error never propagates: transient
// SQLite lock errors are retried next tick within a per-key budget (five attempts
// per change, and the same budget for the orphan and re-advance row work); a
// transient error in the orphan reconciliation or the re-advance never stops the
// tick — it continues to the change loop (Review Focus: run correctness 11); only
// deterministic errors fail the affected run, and one broken run cannot block every
// other run's settlement (Review Focus 3).
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
  attachStepTask, fanoutAttempt, getCursor, getDefinition, getRun, liveRuns, orphanSteps, setCursor, stepByTask, stepsOfRun,
  taskByRequestId, unadvancedDoneSteps, updateRun, updateStep, type StepRow,
} from "./store";
import {
  defaultEngineDeps, failRun, joinFanout, onTaskSettled, readvanceStep, reconcileOrphanStep, settleParentChooseStep,
  stepRequestId, type EngineDeps,
} from "./engine";
import { orchestrateRuns, type OrchestratorDeps } from "./orchestrator";
import { enqueueWakeup, stepWakeRef } from "./wakeups";
import { awaitsReview } from "./review";
import { chooseStepChildRunId } from "./wakeups";
import { isTransientError } from "./transient";

export { isTransientError };

const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];

/** Settles one step task: transient errors are retried on the next tick, but only
 *  a bounded number of times per change (Review Focus: run correctness 6) — after
 *  MAX_TRANSIENT_RETRIES attempts for the same task the change is treated as a
 *  deterministic failure. Deterministic errors are recorded on the run and swallowed
 *  so the batch keeps going; even recording the error must not break the batch, and
 *  a failing failRun must never block the cursor forever. */const MAX_TRANSIENT_RETRIES = 5;
/** Transient retry counts, in memory per task id (Review Focus: run correctness 6);
 *  the map is in-memory only and resets on restart. An entry is pruned when the key
 *  settles by any path: a successful settlement, or the change given up as a
 *  deterministic failure. */
const transientRetries = new Map<string, number>();
/** The same budget for the tick's background row work — orphan re-delegation and
 *  re-advance (Review Focus: run correctness 11) — keyed per step row: one locked
 *  row may not stall every tick, so after MAX_TRANSIENT_RETRIES attempts for the
 *  same row its error is treated as a deterministic failure of that row's work.
 *  The map is in-memory only and resets on restart; an entry is pruned when the
 *  row settles by any path (handled, or its run failed). */
const transientRowRetries = new Map<string, number>();

const rowRetryKey = (row: StepRow): string => `${row.runId}/${row.stepId}#${row.attempt}/${row.branch ?? ""}`;

/** Records one transient failure of a row's reconciliation work. Returns "retry"
 *  while the budget lasts, or "give-up" once it is spent (the entry is pruned). */
function rowTransient(row: StepRow): "retry" | "give-up" {
  const key = rowRetryKey(row);
  const count = (transientRowRetries.get(key) ?? 0) + 1;
  transientRowRetries.set(key, count);
  if (count <= MAX_TRANSIENT_RETRIES) return "retry";
  transientRowRetries.delete(key);
  return "give-up";
}

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
 *  this is one cheap indexed query. A transient error never stops the tick
 *  (Review Focus: run correctness 11): the row retries next tick within its
 *  per-row budget, the loop moves on, and the tick continues to the change loop. */
async function reconcileOrphans(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<number> {
  const orphans = orphanSteps(ctx);
  let handled = 0;
  for (const row of orphans) {
    try {
      const outcome = await reconcileOrphanStep(ctx, row, spawn, deps);
      if (outcome === "attached" || outcome === "redelegated") {
        transientRowRetries.delete(rowRetryKey(row)); // the row settled: prune its retries
        handled++;
      }
    } catch (err) {
      if (isTransientError(err) && rowTransient(row) === "retry") continue; // the tick goes on; this row retries next tick
      // The budget is spent, or the error is deterministic: the row's work failed
      // like a failed start in advanceFrom — the run fails, and a failing failRun
      // leaves the row for the next tick.
      try { await failRun(ctx, row.runId, `re-delegate failed: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
      catch { /* the next tick retries the row */ }
    }
  }
  return handled;
}

/** Re-advances done steps whose outgoing edges may never have been processed
 *  (advanced_at unset: a crash between marking the step done and advancing, or a
 *  run answer whose patch conflicted — Review Focus: run correctness 4). Rows older
 *  than 5 seconds only, so a settlement that its own caller is still advancing is
 *  never raced. A deferred end (Review Focus 5) whose busy siblings are gone ends
 *  the run here. A transient error never stops the tick (Review Focus: run
 *  correctness 11): the row retries next tick within its per-row budget, the loop
 *  moves on, and the tick continues to the change loop. */
async function readvanceStalled(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<number> {
  const stalled = unadvancedDoneSteps(ctx, ctx.now - 5);
  let handled = 0;
  for (const row of stalled) {
    try {
      if (await readvanceStep(ctx, row, spawn, deps)) {
        transientRowRetries.delete(rowRetryKey(row)); // the row advanced: prune its retries
        handled++;
      }
    } catch (err) {
      if (isTransientError(err) && rowTransient(row) === "retry") continue; // the tick goes on; this row retries next tick
      // The budget is spent, or the error is deterministic: the row's re-advance
      // failed like a failed start in advanceFrom — the run fails, and a failing
      // failRun leaves the row for the next tick.
      try { await failRun(ctx, row.runId, `re-advance failed: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
      catch { /* the next tick retries the row */ }
    }
  }
  return handled;
}

/** Steps that wait for review move as soon as their task carries a verdict, a
 *  retry or a failure, whether or not the change log still holds that write. A
 *  transient or git error leaves the row for the next tick. */
async function settleReviewedSteps(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<number> {
  let handled = 0;
  for (const run of liveRuns(ctx)) {
    for (const row of stepsOfRun(ctx, run.id)) {
      if (!awaitsReview(ctx, row)) continue;
      const task = readTask(ctx, row.taskId!);
      if (!task || !(task.review || task.retriedBy || (task.state !== "done" && SETTLE_STATES.includes(task.state)))) continue;
      try {
        await onTaskSettled(ctx, task.id, spawn, deps);
        handled++;
      } catch (err) {
        if (isTransientError(err)) continue;
        try { await failRun(ctx, run.id, `engine error: ${err instanceof Error ? err.message : String(err)}`, undefined, deps); }
        catch { /* the next tick retries */ }
        break;
      }
    }
  }
  return handled;
}

/** A generate step whose child already ended but never settled it: the child's
 *  branch did not merge yet, or the service stopped in between. */
async function settleEndedChildren(ctx: Ctx, spawn: SpawnRunner | undefined, deps: EngineDeps): Promise<number> {
  let handled = 0;
  for (const run of liveRuns(ctx)) {
    for (const row of stepsOfRun(ctx, run.id)) {
      if (row.status !== "waiting") continue;
      const childId = chooseStepChildRunId(row.result);
      const child = childId ? getRun(ctx, childId) : null;
      if (!child || (child.status !== "done" && child.status !== "failed" && child.status !== "stopped")) continue;
      try {
        await settleParentChooseStep(ctx, child, deps, spawn);
        handled++;
      } catch (err) {
        if (isTransientError(err)) continue;
        console.warn(`pacer: workflow tick could not settle child run ${child.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return handled;
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
  for (const run of liveRuns(ctx)) { // live runs only, filtered in SQL (round 4 review)
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
  for (const run of liveRuns(ctx)) { // live runs only, filtered in SQL (round 4 review)
    try {
      const rows = stepsOfRun(ctx, run.id);
      // (a) A claimed failure whose orchestrator wake-up never landed: recreate the
      // wake-up and leave the run live for the orchestrate phase (Phase 2). Fan-out
      // join failures still fail the run below.
      const lostFailures = rows.filter(r => r.branch === undefined && r.status === "failed" && r.advancedAt === undefined);
      if (lostFailures.length > 0) {
        for (const row of lostFailures) {
          const cause = row.error === "no step result" ? "step_invalid" as const : "step_failed" as const;
          enqueueWakeup(ctx, {
            runId: run.id,
            cause,
            ref: stepWakeRef(row.runId, row.stepId, row.attempt, row.branch),
            createdAt: ctx.now,
          });
          try { updateStep(ctx, { runId: run.id, stepId: row.stepId, attempt: row.attempt }, { advancedAt: ctx.now }); }
          catch { /* the row may have changed meanwhile */ }
        }
        const current = getRun(ctx, run.id);
        if (current && current.status === "running") {
          try { updateRun(ctx, run.id, current.rev, { status: "waiting" }); }
          catch { /* concurrent patch */ }
        }
        handled += lostFailures.length;
        // The run stays live for the orchestrator; continue recovery for other rows.
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
          transientRetries.delete(row.taskId); // the key settled by this path: prune its retries
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
        const number = fanoutAttempt(row);
        const key = `${row.stepId}#${number}`;
        const attempt = attempts.get(key) ?? { stepId: row.stepId, attempt: number, joined: false, branches: [] };
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

export async function advanceRuns(
  ctx: Ctx,
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
  orch: OrchestratorDeps = {},
): Promise<{ handled: number; rescanned: boolean; orchestrated: number }> {
  let handled = 0;
  // Orphan reconciliation first, on every tick (not only after a gap): a recovered
  // step may then also have its own change waiting in the log below, which is a no-op.
  // A transient error in it never stops the tick: the tick continues to the change
  // loop (Review Focus: run correctness 11).
  handled += await reconcileOrphans(ctx, spawn, deps);
  // Engine-owned root leaks (dead root replacement left stopped wfroot tasks, or a
  // crash created a root that was never stamped): sweep them each tick.
  try {
    const { reconcileOrphanWorkflowRoots } = await import("./worknode");
    handled += reconcileOrphanWorkflowRoots(ctx).length;
  } catch { /* never block the tick */ }
  // Then the stalled advancements (Review Focus: run correctness 4): a step that is
  // done but was never advanced gets its edges replayed, and a deferred end whose
  // siblings are gone finally ends the run. A transient error here never stops the
  // tick either (Review Focus: run correctness 11).
  handled += await readvanceStalled(ctx, spawn, deps);
  const walk = await processChanges(ctx, getCursor(ctx), spawn, deps);
  handled += walk.handled;
  handled += await settleReviewedSteps(ctx, spawn, deps);
  handled += await settleEndedChildren(ctx, spawn, deps);
  // Recovery last: the change loop settles what the log still holds; the recovery
  // then repairs what a lock error took out of it (Review Focus: run correctness 10).
  // It is skipped when the walk stopped early (a transient or an aborted rescan):
  // the next tick re-processes the log first, then recovers.
  if (!walk.stopped) handled += await recoverLostSettlements(ctx, spawn, deps);
  // Phase 6: sync pacing pauses with the current mode before starting turns, so a
  // loosened mode resumes at the next step boundary / wake window.
  try {
    const { applyPacingToLiveRuns } = await import("./pacing");
    await applyPacingToLiveRuns(ctx, orch.readPacingMode
      ?? (orch.pacingMode !== undefined ? async () => orch.pacingMode! : undefined));
  } catch { /* never block the tick */ }
  // Runs paused at start have no step rows; start def.entry once the pause clears.
  try {
    const { startPendingEntries } = await import("./engine");
    handled += await startPendingEntries(ctx, { deps, spawn });
  } catch { /* never block the tick */ }
  // Fifth phase: start due orchestrator turns, settle terminal ones, recreate lost wake-ups.
  const orchDeps: OrchestratorDeps = { ...orch, ...(spawn && !orch.spawn ? { spawn } : {}) };
  const orchestrated = await orchestrateRuns(ctx, orchDeps);
  return { handled, rescanned: walk.rescanned, orchestrated };
}
