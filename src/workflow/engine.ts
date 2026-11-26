// The run engine: it starts runs, turns agent, human and fanout steps into ordinary
// pacer tasks, settles step instances from task settlement, evaluates conditional and
// bounded back edges, and joins fan-outs. All run changes go through updateRun with
// the current rev (checked and written in one transaction); a step instance links to
// its task only through a workflow_steps row, so ordinary tasks are untouched
// (spec, "Scope").
//
// Delegation and stopping are injectable (EngineDeps) so unit tests can create and
// settle tasks with createTask/updateTask instead of spawning runners; the defaults
// mirror the task.stop op path (getWork ? stopWork : core.tasks.stop).
//
// Step rows are written before their delegation (status running, no task id) and the
// task id is attached afterwards, so a crash between the two never loses a step: the
// row's request id finds the task again (Review Focus: run correctness 2). Every
// engine-made run or step change publishes the run entity the way ops-workflow does,
// without blocking or throwing into the engine.
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import { delegate as delegateTask, stop as stopTaskCore } from "../core/tasks";
import { stopWork } from "../core/work";
import { getWork } from "../dispatch/work";
import { createTask, readTask, updateTask } from "../tasks/store";
import type { TaskState } from "../tasks/types";
import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import { appendActivity } from "../activity/log";
import { backEdgeIndexes } from "./validate";
import { evalCondition, parseCondition } from "./condition";
import { renderPrompt } from "./template";
import {
  attachStepTask, branchOwner, bumpEntryStartAttempts, claimEntryLease,
  claimStepAnswer, claimStepReview, claimStepSettlement, fanoutAttempt, insertBranchRetry, clearEntryLease,
  clearEntrySeed, ENTRY_START_TRANSIENT_MAX, ENTRY_START_TRANSIENT_MIN_S,
  entryLeaseSeconds, fireEdge, getDefinition,
  getRun, insertFanoutBranches, insertJoinStep, isGeneratedRun,
  insertRun, insertStep, leaseNow,
  listQuestions, liveRunsNeedingEntry, newEntryOwner,
  recordDecision, resetEntryStartAttempts, rootRunId,
  runEntityValue, setGraphStatus, setPublishOptIn,
  startRunDelayMs, stepByTask, stepsOfRun,
  taskByRequestId, updateRun, updateStep,
  withdrawOpenQuestionsForRun, workflowDatabase, type RunPatch,
  type RunRow, type StepKey, type StepRow,
  getDefinitionRow, isDefinitionDisabled, isDefinitionInvalid,
  resolveWorkflowPrompt, setPluginDefinitionsDisabled,
} from "./store";
import { assertPluginAllowsWorkflowStart, parsePluginOrigin } from "./plugin-sync";
import { isAdmissionRace, isTransientError } from "./transient";
import { speaksFor } from "./fanout";
import { runPriorityOf, stepDispatchOptions, taskPriorityFor, type RunPriority } from "./priority";
import { isPersonPaused, isRunStepPaused, readPacingMode, syncRunPacingPause } from "./pacing";
import { chooseStepChildRunId, completeWakeupRef, enqueueWakeup, liveTurnForTask, stepWakeRef } from "./wakeups";
import { budgetForDefinition, serializeBudget, serializeSpent } from "./budget";
import { canAutoDecide, orchestratorMayApprove } from "./auto";
import { sanitizeAnswerNote } from "./question-schema";
import { questionEntityValue, raiseHumanStepQuestion, resolveHumanStepQuestion } from "./questions";
import { settleOrchestratorTaskForEndedRun, settleTurn, stopLiveTurnsForRun } from "./orchestrator";
import { ensureRootWorkNode, isWorkNodeRun, startStepTask } from "./worknode";
import { installGeneratedDefinition } from "./generate";
import { adoptGeneratedBranches, ensureRunBranch, mergeTaskOnAccept, taskWorkMerged } from "./branch";
import {
  adoptRetriedStep, awaitsReview, fanoutJoined, isHeldBranch, needsReview, pruneAbandonedConflicts, resumedForFollowUp,
  REVIEW_REJECTED,
} from "./review";
import { branchReportFor, settleRunGitOnTerminal } from "./cleanup";
import { isCodeStep, isPlainObject, type AgentStep, type ChooseWorkflowStep, type FanoutStep, type GenerateStep, type HumanStep, type JsonSchemaLite, type StepResultSchema, type WorkflowDef } from "./schema";
import { loadStrategy, StrategyError, workflowRouterId } from "../config/strategy";
import { missingNeedsPrompt, validateEvidenceResult, type EvidenceNeed } from "./evidence";
import { heldByQuestion, liveTurn } from "./wakeups";
import { MAX_STEP_RETRIES, stepRetriesSpent } from "./retries";

/** Wake the root orchestrator for an auto-effective waiting human step. */
function wakeAutoHumanStep(ctx: Ctx, run: RunRow, stepId: string, attempt: number, stepDef: HumanStep): void {
  if (!canAutoDecide(getRun(ctx, rootRunId(ctx, run.id)) ?? run, stepId, stepDef)) return;
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "question",
    ref: stepWakeRef(run.id, stepId, attempt),
    createdAt: ctx.now,
  });
}

/** Insert the human step's structured question (and auto wake-up when applicable). */
function startHumanWaiting(
  ctx: Ctx,
  run: RunRow,
  stepId: string,
  attempt: number,
  stepDef: HumanStep,
  branch?: string,
): ReturnType<typeof raiseHumanStepQuestion> {
  const q = raiseHumanStepQuestion(ctx, run, stepId, attempt, stepDef, branch);
  wakeAutoHumanStep(ctx, run, stepId, attempt, stepDef);
  return q;
}

/** Task states whose settlement a step instance follows. `partial` and `needs_input`
 *  stay out: Phase 1 has no orchestrator to hand them to (plan, settlement rules). */
const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];
const RUN_TERMINAL: readonly RunRow["status"][] = ["done", "failed", "stopped"];

/**
 * Bounded-retry terminal git settle. Lock-guarded, never deletes remotes.
 * On final failure, logs and appends activity (never swallows). Used by the
 * fire-and-forget scheduler so stop/fail/done do not await the merge lock.
 */
export async function settleRunGitAfterTerminal(
  ctx: Ctx, run: RunRow, o: { timeoutMs?: number } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await settleRunGitOnTerminal(ctx, run, o);
      return;
    } catch (error) {
      if (attempt < 2) {
        await Bun.sleep(250 * (attempt + 1));
        continue;
      }
      const raw = error instanceof Error ? error.message : String(error);
      const text = raw.replace(/\/(?:Users|Volumes|home|tmp)\/[^\s:]+/g, "<path>").slice(0, 400);
      console.error(`pacer: run ${run.id} terminal settle failed: ${text}`);
      try {
        appendActivity(ctx, {
          kind: "task_settled",
          level: "warn",
          text: `run ${run.id} terminal settle failed: ${text}. The integration worktree and merged task branches are still on disk; run \`pacer run cleanup ${run.id}\` to remove them.`,
          repo: run.repo,
        });
      } catch { /* activity must not block settle reporting */ }
    }
  }
}

/** In-flight background settles (test helper + idempotent re-entry). */
const pendingTerminalSettles = new Map<string, Promise<void>>();

/** Fire-and-forget wrapper so patchRun returns while settle waits on the merge lock. */
function scheduleSettleRunGit(ctx: Ctx, run: RunRow): void {
  const prior = pendingTerminalSettles.get(run.id);
  const next = (prior ?? Promise.resolve())
    .catch(() => {})
    .then(() => settleRunGitAfterTerminal(ctx, run))
    .finally(() => {
      if (pendingTerminalSettles.get(run.id) === next) pendingTerminalSettles.delete(run.id);
    });
  pendingTerminalSettles.set(run.id, next);
}

/** Wait for a scheduled terminal settle (tests that assert post-stop git cleanup). */
export function awaitTerminalSettle(runId: string): Promise<void> {
  return pendingTerminalSettles.get(runId) ?? Promise.resolve();
}

export interface EngineDeps {
  delegate: typeof delegateTask;
  /** The task.stop op path (src/api/ops.ts): a work node stops through stopWork,
   *  a plain task through core.tasks.stop. */
  stopTask: (ctx: Ctx, id: string) => void;
}

export const defaultEngineDeps: EngineDeps = {
  delegate: (ctx, input, spawn) => delegateTask(ctx, input, spawn),
  stopTask: (ctx, id) => {
    if (getWork(ctx, id)) stopWork(ctx, id);
    else stopTaskCore(ctx, id);
  },
};

export interface StartOptions {
  deps?: EngineDeps;
  spawn?: SpawnRunner;
  /** When set, startEntryIfNeeded renews this owner instead of claiming a new one. */
  entryOwner?: string;
  /**
   * Test-only: after a successful claim, before entry start work. Lets a second
   * starter insert the entry row so the engine observes a real UNIQUE race.
   */
  afterEntryClaim?: (ctx: Ctx, runId: string) => void | Promise<void>;
}

/**
 * UNIQUE/PRIMARY KEY collision on an ENTRY step key — another starter already won.
 * Never match on empty run/step ids (`''.includes('')`); require the entry PK columns
 * or both concrete values when the driver embeds them.
 */
export function isEntryStepAlreadyStarted(err: unknown, runId: string, entryStepId: string): boolean {
  if (!runId || !entryStepId) return false;
  const msg = err instanceof Error ? err.message : String(err);
  if (!/UNIQUE|unique|constraint/i.test(msg)) return false;
  // SQLite: "UNIQUE constraint failed: workflow_steps.run_id, workflow_steps.step_id, …"
  if (/workflow_steps\.run_id/i.test(msg) && /workflow_steps\.step_id/i.test(msg)) return true;
  // Some drivers embed the conflicting values; require both non-empty keys.
  if (msg.includes(runId) && msg.includes(entryStepId)) return true;
  return false;
}

/**
 * Renew entry ownership from a live clock.
 * Transient lock → busy (keep going); lost claim → lost; any other error → unknown
 * (never throw into a timer callback; caller treats unknown like lost).
 */
export function renewEntryLease(ctx: Ctx, runId: string, owner: string): "ok" | "lost" | "busy" | "unknown" {
  try {
    const now = leaseNow(ctx);
    if (!claimEntryLease(ctx, runId, owner, now + entryLeaseSeconds(ctx), now)) return "lost";
    return "ok";
  } catch (e) {
    if (isTransientError(e)) return "busy";
    console.warn(
      `pacer: renewEntryLease non-transient for ${runId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "unknown";
  }
}

export type EntryLeaseCtl = {
  /** Renew now; returns false when the lease is lost or unknown (stop starting). */
  renew: () => boolean;
  /** True once renew saw lost/unknown (including heartbeat). */
  lost: () => boolean;
};

/**
 * Hold an already-claimed entry lease for the duration of `fn`: heartbeat renewals,
 * await-boundary renew helpers, lost-lease stop without failRun, and clearInterval
 * on every exit. Shared by startRun and startEntryIfNeeded so they cannot drift.
 */
export async function withEntryLease<T>(
  ctx: Ctx,
  runId: string,
  owner: string,
  fn: (ctl: EntryLeaseCtl) => Promise<T>,
): Promise<{ value?: T; leaseLost: boolean; error?: unknown }> {
  let leaseLost = false;
  const renew = (): boolean => {
    const result = renewEntryLease(ctx, runId, owner);
    if (result === "lost" || result === "unknown") {
      leaseLost = true;
      return false;
    }
    return true;
  };
  const ctl: EntryLeaseCtl = {
    renew,
    lost: () => leaseLost,
  };
  const leaseS = entryLeaseSeconds(ctx);
  const heartbeatMs = Math.max(1_000, Math.floor((leaseS * 1000) / 3));
  const schedule = ctx.setInterval ?? setInterval;
  const cancel = ctx.clearInterval ?? clearInterval;
  const heartbeat = schedule(() => {
    try {
      renew();
    } catch (e) {
      // Never let a timer callback crash the service process.
      console.warn(
        `pacer: entry-lease heartbeat error for ${runId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      leaseLost = true;
    }
  }, heartbeatMs);
  (heartbeat as { unref?: () => void }).unref?.();
  try {
    const value = await fn(ctl);
    return { value, leaseLost };
  } catch (error) {
    return { leaseLost, error };
  } finally {
    cancel(heartbeat);
    // Owner-matched: no-op when another owner already claimed.
    clearEntryLease(ctx, runId, owner);
  }
}

interface EngineOptions {
  deps: EngineDeps;
  spawn?: SpawnRunner;
  /** When true, orch→orch re-entry from onTaskSettled may settle this turn's live orch turn. */
  settleLiveOrchTurn?: boolean;
}

const withDefaults = (o?: StartOptions): EngineOptions => ({ deps: o?.deps ?? defaultEngineDeps, spawn: o?.spawn });

const keyOf = (s: StepRow): StepKey => ({ runId: s.runId, stepId: s.stepId, attempt: s.attempt, ...(s.branch !== undefined ? { branch: s.branch } : {}) });

/** The delegation request id of a step instance: stable per attempt, so a step row
 *  written before its delegation can always find (or re-create) its task. */
export function stepRequestId(runId: string, stepId: string, attempt: number, branch?: string): string {
  return `wf:${runId}:${stepId}:${attempt}:${branch ?? ""}`;
}

const stepTitle = (run: RunRow, stepId: string, branch?: string): string => {
  const text = branch ? `${run.title} · ${stepId} · ${branch}` : `${run.title} · ${stepId}`;
  // DelegateInput titles are capped at 60 characters by delegate validation.
  return text.length > 60 ? text.slice(0, 60) : text;
};

/** One-based, deterministic from the stored rows: a restart before the step row is
 *  written recomputes the same attempt, so the same requestId makes delegation
 *  idempotent (plan, agent-step rules). */
function nextAttempt(ctx: Ctx, runId: string, stepId: string): number {
  return stepsOfRun(ctx, runId).reduce((max, s) => s.stepId === stepId && s.attempt > max ? s.attempt : max, 0) + 1;
}

/** The latest result of each finished step, for `{{steps.<id>.result…}}` templates.
 *  Rows are ordered by start time, so the newest attempt (and a fan-out's join row)
 *  wins. */
function stepResults(ctx: Ctx, runId: string): Record<string, { result?: unknown }> {
  const latest = new Map<string, StepRow>();
  for (const row of stepsOfRun(ctx, runId)) {
    if (row.result === undefined) continue;
    const prior = latest.get(row.stepId);
    if (!prior || speaksFor(row, prior)) latest.set(row.stepId, row);
  }
  return Object.fromEntries([...latest].map(([id, row]) => [id, { result: row.result }]));
}

/** Publishes a run entity event the way ops-workflow does. publish() already swallows
 *  its own transport errors; the extra catch keeps the engine free of publishing. */
async function publishRunChange(ctx: Ctx, run: RunRow | null): Promise<void> {
  if (!run) return;
  try {
    await publish(ctx, [{ type: "entity", data: { kind: "run", id: run.id, value: runEntityValue(run) } }]);
  } catch { /* publishing must never throw into the engine */ }
}

/** Re-reads the run and fails loudly when it is gone or terminal, so a status write
 *  never lands on a run another caller just ended. */
function liveRun(ctx: Ctx, runId: string): RunRow {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${runId} is ${run.status}`);
  return run;
}

/** Applies a run patch against the current rev and publishes the change. Terminal
 *  runs stay terminal: patching one is a conflict (an end edge never overwrites a
 *  stopped run). */
async function patchRun(ctx: Ctx, runId: string, patch: RunPatch, o?: EngineOptions): Promise<RunRow> {
  const run = liveRun(ctx, runId);
  // Terminal status + question withdrawal share one transaction (M-j): a crash
  // between updateRun and withdraw must not leave open questions on a terminal run.
  let withdrawn: ReturnType<typeof withdrawOpenQuestionsForRun> = [];
  const updated = workflowDatabase(ctx).transaction(() => {
    const next = updateRun(ctx, runId, run.rev, patch);
    if (patch.status && RUN_TERMINAL.includes(patch.status)) {
      withdrawn = withdrawOpenQuestionsForRun(ctx, runId);
    }
    return next;
  })();
  await publishRunChange(ctx, updated);
  // Only a root run terminal stops the shared orchestrator turn (round-2 I1).
  // A choose_workflow child ending must leave the root's live turn alone.
  if (patch.status && RUN_TERMINAL.includes(patch.status) && !updated.parentRunId) {
    const terminal = patch.status as "done" | "failed" | "stopped";
    stopLiveTurnsForRun(ctx, runId, `run ${terminal}`, {
      stopTask: o?.deps?.stopTask,
    });
    // Re-entry / choose deferral can leave the orch task queued with no live turn
    // (stopLiveTurnsForRun finds nothing). Terminalize it so running-work/queue
    // does not keep counting engine-owned orchestrate work for a stopped run (I4).
    // When a live turn remains (stopPending / owned attempt still stopping), leave
    // the orch task to that path — do not force-settle under the turn.
    if (!liveTurn(ctx, rootRunId(ctx, runId))) {
      settleOrchestratorTaskForEndedRun(ctx, updated, terminal);
    }
  }
  if (patch.status && RUN_TERMINAL.includes(patch.status)) {
    for (const q of withdrawn) {
      void publish(ctx, [{
        type: "entity",
        data: { kind: "question", id: q.id, value: questionEntityValue(q) },
      }]).catch(() => {});
    }
    settleRootWorkNode(ctx, updated, patch.status === "failed" ? "failed" : patch.status === "stopped" ? "stopped" : "done");
    // Terminal status is already committed. Git settle takes the merge lock (up to
    // ~150 s) and must not block stop/fail/done; run it in the background with
    // bounded retries and report a final failure instead of swallowing it.
    scheduleSettleRunGit(ctx, updated);
  }
  if (patch.status && RUN_TERMINAL.includes(patch.status) && updated.parentRunId && updated.parentStep) {
    await settleParentChooseStep(ctx, updated, o?.deps ?? defaultEngineDeps, o?.spawn);
  }
  return updated;
}

/** Runs whose failRun cascade is in progress — settleParentChooseStep skips wakes. */
const failingRuns = new Set<string>();

/** Stops a step row's task, unless it finished and only waits for a verdict:
 *  that task stays as it is, still reviewable. A resumed one is stopped. */
function stopStepTask(ctx: Ctx, row: StepRow, deps: EngineDeps): void {
  if (!row.taskId) return;
  if (awaitsReview(ctx, row) && ["done", "partial"].includes(readTask(ctx, row.taskId)?.state ?? "done")) return;
  try { deps.stopTask(ctx, row.taskId); } catch { /* ending a step must not depend on one task */ }
}

/** Fails a run with a reason (and optionally the loop counters that led there) and
 *  stops its in-flight step tasks; those rows are marked stopped too. Terminal runs
 *  stay terminal. */
export async function failRun(ctx: Ctx, runId: string, reason: string, loops?: Record<string, number>, deps: EngineDeps = defaultEngineDeps): Promise<void> {
  const current = getRun(ctx, runId);
  if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(current.status)) return;
  failingRuns.add(runId);
  try {
    // Fail live children first so their settlement sees a live parent with matching childRunId.
    const children = workflowDatabase(ctx).query<{ id: string }, [string]>(
      "SELECT id FROM workflow_runs WHERE parent_run_id = ? AND status IN ('running', 'waiting')",
    ).all(runId);
    for (const child of children) {
      try { await failRun(ctx, child.id, reason, undefined, deps); } catch { /* */ }
    }
    await patchRun(ctx, runId, { status: "failed", reason, ...(loops ? { loops } : {}) }, { deps, spawn: undefined });
    for (const row of stepsOfRun(ctx, runId)) {
      if (row.status !== "running" && !awaitsReview(ctx, row)) continue;
      stopStepTask(ctx, row, deps);
      try { updateStep(ctx, keyOf(row), { status: "stopped", error: "run failed", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
    }
    pruneAbandonedConflicts(ctx, runId);
  } finally {
    failingRuns.delete(runId);
  }
}

function loadDefinition(ctx: Ctx, run: RunRow): WorkflowDef | null {
  return getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
}

const isTerminal = (run: RunRow | null): boolean => !run || RUN_TERMINAL.includes(run.status);

/** A step's outgoing edges whose `when` holds for `result` (an edge without one
 *  always fires), with their definition indexes. Never throws: a malformed
 *  condition or result evaluates to false (condition.ts). */
function matchedEdges(def: WorkflowDef, run: RunRow, stepId: string, result: unknown): { edge: WorkflowDef["edges"][number]; index: number }[] {
  const matched: { edge: WorkflowDef["edges"][number]; index: number }[] = [];
  def.edges.forEach((edge, index) => {
    if (edge.from !== stepId) return;
    if (edge.when !== undefined) {
      const parsed = parseCondition(edge.when);
      if (!parsed.ast || !evalCondition(parsed.ast, { result, brief: run.brief })) return;
    }
    matched.push({ edge, index });
  });
  return matched;
}

/** Attaches a delegated task to its step row and settles at once when the task is
 *  already terminal (a fast settle, or the request-id dedupe returned a prior task).
 *  The settlement is claimed atomically inside onTaskSettled, so a concurrent tick
 *  settlement of the same task can never advance the run twice. */
async function attachAndSettle(ctx: Ctx, key: StepKey, taskId: string, e: EngineOptions): Promise<StepRow> {
  const attached = attachStepTask(ctx, key, taskId);
  const task = readTask(ctx, taskId);
  if (task && SETTLE_STATES.includes(task.state)) {
    await onTaskSettled(ctx, taskId, e.spawn, e.deps);
    const settled = stepsOfRun(ctx, key.runId).find(s => s.stepId === key.stepId && s.attempt === key.attempt && (s.branch ?? undefined) === (key.branch ?? undefined));
    return settled ?? attached;
  }
  return attached;
}

/** Starts one step instance: agent steps delegate a task (idempotent per instance
 *  through an active-row check and the request id), human steps wait, fan-outs
 *  delegate one task per branch. */
export async function startStep(ctx: Ctx, run: RunRow, def: WorkflowDef, stepId: string, branch?: string, o?: StartOptions): Promise<StepRow> {
  const e = withDefaults(o);
  liveRun(ctx, run.id); // a terminal run starts nothing
  // Pause takes effect at step boundaries: no new step while paused.
  if (isRunStepPaused(getRun(ctx, run.id) ?? run)) {
    throw new CoreError("not_allowed", `run ${run.id} is paused (${(getRun(ctx, run.id) ?? run).pausedReason})`);
  }
  const stepDef = def.steps[stepId];
  if (!stepDef) throw new CoreError("not_found", `workflow '${def.id}' has no step '${stepId}'`);
  if (stepDef.type === "end") throw new CoreError("invalid_input", `step '${stepId}' is an end step and never runs as a task`);
  if (stepDef.type !== "fanout") {
    const active = stepsOfRun(ctx, run.id).find(s =>
      s.stepId === stepId && (s.branch ?? undefined) === (branch ?? undefined) && (s.status === "running" || s.status === "waiting"));
    if (active) {
      // human / choose_workflow / generate wait without a task id by design.
      if (active.taskId || stepDef.type === "human" || stepDef.type === "choose_workflow" || stepDef.type === "generate") {
        return active;
      }
      // A row written before a crash during delegation: reuse its attempt and
      // request id instead of delegating a duplicate.
      if (stepDef.type !== "agent") throw new CoreError("conflict", `step '${stepId}' is stuck without a task`);
      return startAgentStep(ctx, getRun(ctx, run.id)!, def, stepId, stepDef, branch, active.attempt, e);
    }
  }
  const attempt = nextAttempt(ctx, run.id, stepId);
  if (stepDef.type === "human") {
    const db = workflowDatabase(ctx);
    const row = db.transaction(() => {
      const inserted = insertStep(ctx, { runId: run.id, stepId, attempt, status: "waiting" });
      startHumanWaiting(ctx, run, stepId, attempt, stepDef);
      return inserted;
    })();
    if (!isTerminal(getRun(ctx, run.id))) await patchRun(ctx, run.id, { status: "waiting" });
    return row;
  }
  if (stepDef.type === "fanout") return startFanout(ctx, run, stepId, stepDef, attempt, e);
  if (stepDef.type === "choose_workflow") {
    return startChooseWorkflowStep(ctx, run, stepId, stepDef, attempt);
  }
  if (stepDef.type === "generate") {
    return startGenerateStep(ctx, run, stepId, stepDef, attempt);
  }
  if (stepDef.type === "agent" && stepDef.role === "orchestrator") {
    return startOrchestratorRoleStep(ctx, run, def, stepId, stepDef, attempt);
  }
  return startAgentStep(ctx, run, def, stepId, stepDef, branch, attempt, e);
}

/** Ensures the run has an orchestrator task (kind orchestrate) without a step row. */
function ensureOrchestratorTask(ctx: Ctx, run: RunRow): string {
  if (run.orchestratorTaskId && readTask(ctx, run.orchestratorTaskId)) return run.orchestratorTaskId;
  let planner = run.planner;
  if (!planner) {
    try { planner = loadStrategy(ctx).planner.agent; } catch { planner = "claude-code"; }
  }
  const task = createTask(ctx, {
    brief: { goal: `orchestrate ${run.id}`, repo: run.repo },
    kind: "orchestrate",
    requestedExecutor: planner ?? null,
    timeoutS: 20 * 60,
    title: `orchestrate ${run.id}`.slice(0, 60),
    requestId: `orch:${rootRunId(ctx, run.id)}`,
  });
  try { updateRun(ctx, run.id, run.rev, { orchestratorTaskId: task.id, planner: planner ?? undefined }); }
  catch { /* concurrent */ }
  return task.id;
}

/** A role:orchestrator step: no new task; links the shared orchestrator task and wakes a turn.
 *  A back-edge re-entry must not settle against a prior attempt's done/failed task: clear
 *  settlement before attaching so tick recovery cannot mark this attempt "no step result"
 *  before startTurn launches the new turn (P7-W4-revise-brainstorm-reuse). */
async function startOrchestratorRoleStep(
  ctx: Ctx,
  run: RunRow,
  def: WorkflowDef,
  stepId: string,
  stepDef: AgentStep,
  attempt: number,
  opts?: { settleLiveOrchTurn?: boolean },
): Promise<StepRow> {
  const orchTaskId = ensureOrchestratorTask(ctx, getRun(ctx, run.id)!);
  // UNIQUE(task_id): clear any prior attempt's link so this attempt can own it.
  workflowDatabase(ctx).query("UPDATE workflow_steps SET task_id = NULL WHERE task_id = ?").run(orchTaskId);
  const prompt = renderPrompt(resolveWorkflowPrompt(ctx, run.workflow, run.version, stepDef.prompt), {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    run: { id: run.id, stepId },
  });
  // Stash the rendered prompt for the next turn — do not launch here; only startTurn
  // may spawn the orchestrator runner (D2.10). Still leave the task non-settled so a
  // re-entered attempt cannot be failed by recoverLostSettlements against attempt N-1.
  // When re-entry is reached from onTaskSettled of the same orch task (direct orch→orch
  // or self-loop), settling flipped T to done then we would requeue it while the prior
  // turn stayed running — orchestrateRuns only settles when the task is terminal, so the
  // new wakeup could not claim until the 20-min deadline. Settle that live turn first.
  // Only on the onTaskSettled path (settleLiveOrchTurn): answerHumanStep / choose mid-turn
  // must not force-settle a still-driving live turn of the shared orch task.
  const rootForTurn = rootRunId(ctx, run.id);
  const priorTurn = liveTurn(ctx, rootForTurn);
  if (
    opts?.settleLiveOrchTurn
    && priorTurn
    && priorTurn.taskId === orchTaskId
    && (priorTurn.status === "running" || priorTurn.status === "starting")
  ) {
    await settleTurn(ctx, priorTurn.id, { outcome: "done" });
  }
  updateTask(ctx, orchTaskId, t => {
    t.brief = { goal: prompt, repo: run.repo };
    t.kind = "orchestrate";
    if (SETTLE_STATES.includes(t.state)) {
      t.state = "queued";
      delete t.result;
      delete t.settledAt;
      delete t.queue;
      delete t.reviewRequest;
      delete t.progress;
      delete t.runnerPid;
    }
  });
  const key: StepKey = { runId: run.id, stepId, attempt };
  const existing = stepsOfRun(ctx, run.id).find(s =>
    s.stepId === stepId && s.attempt === attempt && s.branch === undefined);
  let row: StepRow;
  if (existing) {
    row = existing.taskId === orchTaskId ? existing : attachStepTask(ctx, key, orchTaskId);
  } else {
    row = insertStep(ctx, { ...key, status: "running", taskId: orchTaskId });
  }
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "orchestrator_step",
    ref: stepWakeRef(run.id, stepId, attempt),
    createdAt: ctx.now,
  });
  if (!isTerminal(getRun(ctx, run.id)) && getRun(ctx, run.id)?.status === "running") {
    try { await patchRun(ctx, run.id, { status: "waiting" }); }
    catch { /* */ }
  }
  return row;
}

/** choose_workflow: wait for the orchestrator to call run.choose; wake a turn. */
async function startChooseWorkflowStep(
  ctx: Ctx,
  run: RunRow,
  stepId: string,
  _stepDef: ChooseWorkflowStep,
  attempt: number,
): Promise<StepRow> {
  ensureOrchestratorTask(ctx, getRun(ctx, run.id)!);
  const existing = stepsOfRun(ctx, run.id).find(s =>
    s.stepId === stepId && s.attempt === attempt && s.branch === undefined);
  const row = existing
    ? updateStep(ctx, { runId: run.id, stepId, attempt }, { status: "waiting" })
    : insertStep(ctx, { runId: run.id, stepId, attempt, status: "waiting" });
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "orchestrator_step",
    ref: stepWakeRef(run.id, stepId, attempt),
    createdAt: ctx.now,
  });
  if (!isTerminal(getRun(ctx, run.id))) {
    try { await patchRun(ctx, run.id, { status: "waiting" }); }
    catch { /* */ }
  }
  return row;
}

/** generate: wait for submitGraph (approval/child run are Task 4); wake a turn. */
async function startGenerateStep(
  ctx: Ctx,
  run: RunRow,
  stepId: string,
  _stepDef: GenerateStep,
  attempt: number,
): Promise<StepRow> {
  ensureOrchestratorTask(ctx, getRun(ctx, run.id)!);
  const existing = stepsOfRun(ctx, run.id).find(s =>
    s.stepId === stepId && s.attempt === attempt && s.branch === undefined);
  const row = existing
    ? updateStep(ctx, { runId: run.id, stepId, attempt }, { status: "waiting" })
    : insertStep(ctx, { runId: run.id, stepId, attempt, status: "waiting" });
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "orchestrator_step",
    ref: stepWakeRef(run.id, stepId, attempt),
    createdAt: ctx.now,
  });
  if (!isTerminal(getRun(ctx, run.id))) {
    try { await patchRun(ctx, run.id, { status: "waiting" }); }
    catch { /* */ }
  }
  return row;
}

/** Top-level / choose target: refuse disabled or ungranted plugin workflows with the
 *  same not_allowed text as run.start. Generate/replan children skip this via
 *  startRun's skipLiveGate (pinned run-tree exemption). */
function assertDefinitionStartAllowed(ctx: Ctx, workflowRef: string): void {
  const def = getDefinition(ctx, workflowRef);
  if (!def) throw new CoreError("not_found", `unknown workflow '${workflowRef}'`);
  const defRef = `${def.id}@${def.version}`;
  const defRow = getDefinitionRow(ctx, defRef);
  // Schema-invalid stored defs stay unstartable across sync/reconcile (distinct from plugin-live disabled).
  if (isDefinitionInvalid(ctx, defRef)) {
    throw new CoreError("not_allowed", `workflow '${defRef}' is invalid`);
  }
  const pluginOrigin = defRow?.origin ? parsePluginOrigin(defRow.origin) : null;
  if (pluginOrigin && defRow?.origin) {
    assertPluginAllowsWorkflowStart(ctx, defRow.origin, def.id);
    if (isDefinitionDisabled(ctx, defRef)) {
      try { setPluginDefinitionsDisabled(ctx, pluginOrigin.pluginId, false); }
      catch { /* best-effort; start is still allowed */ }
    }
  } else if (isDefinitionDisabled(ctx, defRef)) {
    throw new CoreError("not_allowed", `workflow '${defRef}' is disabled`);
  }
}

/** Grant op: start a child run for a choose_workflow step. */
export async function chooseWorkflow(
  ctx: Ctx,
  input: { runId: string; stepId: string; workflow: string; reason: string },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  const def = loadDefinition(ctx, run);
  const stepDef = def?.steps[input.stepId];
  if (!stepDef || stepDef.type !== "choose_workflow") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not a choose_workflow step`);
  }
  if (stepDef.from && stepDef.from.length > 0 && !stepDef.from.includes(input.workflow)) {
    throw new CoreError("not_allowed", `workflow '${input.workflow}' is outside the allowed from list`);
  }
  const childDef = getDefinition(ctx, input.workflow);
  if (!childDef) throw new CoreError("not_found", `unknown workflow '${input.workflow}'`);
  // Choose targets a fresh definition: gate before claiming so a disabled /
  // ungranted plugin cannot be started as a child of an already-running router.
  assertDefinitionStartAllowed(ctx, input.workflow);
  // Compare-and-set claim before startRun so two concurrent chooses cannot both
  // create children (A-m1). A prior childRunId or choosing marker refuses.
  const row = workflowDatabase(ctx).transaction(() => {
    const waiting = stepsOfRun(ctx, run.id).filter(s => s.stepId === input.stepId && s.status === "waiting");
    const latest = waiting[waiting.length - 1];
    if (!latest) throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a choice`);
    const priorChild = chooseStepChildRunId(latest.result);
    if (priorChild) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} already chose child ${priorChild}`);
    }
    if (latest.result != null && typeof latest.result === "object"
      && (latest.result as { choosing?: unknown }).choosing === true) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} is already choosing a child`);
    }
    updateStep(ctx, keyOf(latest), {
      result: { workflow: input.workflow, reason: input.reason, choosing: true, choosingAt: ctx.now },
    });
    return latest;
  })();
  const rootId = rootRunId(ctx, run.id);
  const root = getRun(ctx, rootId)!;
  let child: RunRow;
  try {
    child = await startRun(ctx, {
      workflow: input.workflow,
      repo: run.repo,
      brief: run.brief,
      title: `${run.title} · ${input.workflow}`,
    }, spawn, deps, {
      parentRunId: run.id,
      parentStep: input.stepId,
      planner: root.planner,
      orchestratorTaskId: root.orchestratorTaskId,
      sessionId: root.sessionId,
      // The person's draft opt-in follows the work to the chosen workflow, which
      // has its own publish steps.
      ...(root.publishOptIn ?? run.publishOptIn ? { publishOptIn: "draft" as const } : {}),
    });
  } catch (err) {
    // Release only while still waiting+choosing — never wipe a settleParentChooseStep
    // result after failRun already finished the parent step (S-M1).
    try {
      const fresh = stepsOfRun(ctx, row.runId).find(s =>
        s.stepId === row.stepId && s.attempt === row.attempt
        && (row.branch !== undefined ? s.branch === row.branch : !s.branch),
      );
      const choosing = fresh?.result != null && typeof fresh.result === "object"
        && (fresh.result as { choosing?: unknown }).choosing === true;
      if (fresh?.status === "waiting" && choosing) {
        updateStep(ctx, keyOf(row), { result: null });
      }
    } catch { /* */ }
    throw err;
  }
  // Stash the choice reason; the child's end fills the final result and advances.
  updateStep(ctx, keyOf(row), { result: { workflow: input.workflow, reason: input.reason, childRunId: child.id } });
  return child;
}

/** Delegates the task for an already-inserted agent step row and attaches it (with
 *  an at-most-once fast settle when the task is already terminal). Used both by the
 *  start path and by the trigger-transaction advancement, which inserts the row
 *  first and delegates after the transaction, so a crash before the delegation is
 *  an ordinary orphan the reconciliation recovers. */
type StepBrief = {
  brief: { goal: string; repo: string; base?: string; commitWork?: boolean };
  placement: { worktree?: "new"; worktree_reason?: string };
};

/**
 * The step task's brief and placement. A code step gets its own worktree from the
 * run branch tip (created on first use) and is told to commit. Every other step of
 * a run that has a branch also starts from that tip, so it sees the accepted work.
 */
async function stepBrief(ctx: Ctx, run: RunRow, stepDef: AgentStep, prompt: string): Promise<StepBrief> {
  const brief: StepBrief["brief"] = { goal: prompt, repo: run.repo };
  if (!isCodeStep(stepDef)) {
    const branch = branchOwner(ctx, run).branch;
    if (!branch) return { brief, placement: {} };
    brief.base = branch;
    return { brief, placement: { worktree: "new", worktree_reason: "workflow step starts from the run branch" } };
  }
  // Code steps must get a dedicated worktree/branch from the run tip (I2).
  const placement = { worktree: "new" as const, worktree_reason: "workflow code step" };
  try {
    const ensured = await ensureRunBranch(ctx, getRun(ctx, run.id) ?? run);
    brief.base = ensured.branch;
    brief.commitWork = true;
  } catch (error) {
    // Phase 1–3 unit fixtures often use a tmp dir with a fake RunFn and no git.
    // A real run always has a git repo; other errors still fail the step.
    if (error instanceof CoreError && error.code === "invalid_input" && /not a git repository/i.test(error.message)) {
      return { brief, placement };
    }
    throw error;
  }
  return { brief, placement };
}

const ADMISSION_ATTEMPTS = 5;

/** Makes a step's delegation again when admission raced another task change. */
async function admitted<T>(delegate: () => Promise<T>): Promise<T> {
  for (let attempt = 1;; attempt++) {
    try { return await delegate(); }
    catch (err) {
      if (!isAdmissionRace(err) || attempt >= ADMISSION_ATTEMPTS) throw err;
      await Bun.sleep(200 * attempt);
    }
  }
}

async function delegateAgentRow(ctx: Ctx, run: RunRow, row: StepRow, stepDef: AgentStep, e: EngineOptions): Promise<StepRow> {
  let prompt = renderPrompt(resolveWorkflowPrompt(ctx, run.workflow, run.version, stepDef.prompt), {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    branch: row.branch,
    run: { id: run.id, stepId: row.stepId },
  });
  if (stepDef.needs && stepDef.needs.length > 0) {
    const note = missingNeedsPrompt(stepDef.needs, advertisedEvidenceTools(ctx));
    if (note) prompt = `${prompt}\n\n${note}`;
  }
  const key = keyOf(row);
  const requestId = stepRequestId(run.id, row.stepId, row.attempt, row.branch);
  const live = getRun(ctx, run.id) ?? run;
  const priority = taskPriorityFor(runPriorityOf(live));
  const workNode = isWorkNodeRun(live);
  const dispatch = stepDispatchOptions(priority, workNode);
  const { brief, placement } = await stepBrief(ctx, live, stepDef, prompt);
  const task = await admitted(() => workNode
    ? startStepTask(ctx, live, {
      brief,
      kind: stepDef.kind,
      ...(stepDef.difficulty ? { difficulty: stepDef.difficulty } : {}),
      title: stepTitle(live, row.stepId, row.branch),
      requestId,
      priority,
      ...placement,
    }, e.deps.delegate, e.spawn)
    : e.deps.delegate(ctx, {
      brief,
      kind: stepDef.kind,
      ...(stepDef.difficulty ? { difficulty: stepDef.difficulty } : {}),
      title: stepTitle(live, row.stepId, row.branch),
      requestId,
      ...(dispatch ? { dispatch } : {}),
      ...placement,
    }, e.spawn));
  // Re-read after the await: the run may have gone terminal while the delegation was
  // pending; then the task is stopped and nothing else happens.
  if (isTerminal(getRun(ctx, run.id))) {
    try { e.deps.stopTask(ctx, task.id); } catch { /* stopping must not throw into the engine */ }
    try { updateStep(ctx, key, { status: "stopped", error: "run stopped while delegating", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
    return updateStep(ctx, key, {});
  }
  return attachAndSettle(ctx, key, task.id, e);
}

async function startAgentStep(ctx: Ctx, run: RunRow, def: WorkflowDef, stepId: string, stepDef: AgentStep, branch: string | undefined, attempt: number, e: EngineOptions): Promise<StepRow> {
  const key: StepKey = { runId: run.id, stepId, attempt, ...(branch !== undefined ? { branch } : {}) };
  const requestId = stepRequestId(run.id, stepId, attempt, branch);
  // The row exists before the delegation, so a crash in between leaves a recoverable
  // step (status running, no task id) instead of a lost one: its request id finds the
  // reserved task (or the delegate's dedupe returns it) and the id is attached after.
  const existing = stepsOfRun(ctx, run.id).some(s => s.stepId === key.stepId && s.attempt === key.attempt && (s.branch ?? undefined) === (key.branch ?? undefined));
  if (existing) {
    const prior = taskByRequestId(ctx, requestId);
    if (prior) return attachAndSettle(ctx, key, prior.id, e);
  }
  let row: StepRow;
  if (existing) {
    row = updateStep(ctx, key, { status: "running" }); // an orphan row keeps its started_at
  } else {
    try {
      row = insertStep(ctx, { ...key, status: "running" });
    } catch (err) {
      // Concurrent entry starter won the PRIMARY KEY — reuse their row (B1 safety net).
      if (!/UNIQUE|unique|constraint/i.test(err instanceof Error ? err.message : String(err))) throw err;
      const won = stepsOfRun(ctx, run.id).find(s =>
        s.stepId === key.stepId && s.attempt === key.attempt
        && (s.branch ?? undefined) === (key.branch ?? undefined));
      if (!won) throw err;
      if (won.taskId) return won;
      row = won;
    }
  }
  return delegateAgentRow(ctx, getRun(ctx, run.id)!, row, stepDef, e);
}

/** Delegates the task for an already-inserted fan-out branch row (see
 *  delegateAgentRow for the insert-first-then-delegate rationale). */
async function delegateFanoutBranch(ctx: Ctx, run: RunRow, row: StepRow, stepDef: FanoutStep, e: EngineOptions): Promise<StepRow> {
  const branch = row.branch!;
  const prompt = renderPrompt(resolveWorkflowPrompt(ctx, run.workflow, run.version, stepDef.each.prompt), {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    branch,
    run: { id: run.id, stepId: row.stepId },
  });
  const key = keyOf(row);
  const live = getRun(ctx, run.id) ?? run;
  const requestId = stepRequestId(run.id, row.stepId, row.attempt, branch);
  const priority = taskPriorityFor(runPriorityOf(live));
  const workNode = isWorkNodeRun(live);
  const dispatch = stepDispatchOptions(priority, workNode);
  const { brief, placement } = await stepBrief(ctx, live, stepDef.each, prompt);
  const task = await admitted(() => workNode
    ? startStepTask(ctx, live, {
      brief,
      kind: stepDef.each.kind,
      ...(stepDef.each.difficulty ? { difficulty: stepDef.each.difficulty } : {}),
      title: stepTitle(live, row.stepId, branch),
      requestId,
      priority,
      ...placement,
    }, e.deps.delegate, e.spawn)
    : e.deps.delegate(ctx, {
      brief,
      kind: stepDef.each.kind,
      ...(stepDef.each.difficulty ? { difficulty: stepDef.each.difficulty } : {}),
      title: stepTitle(live, row.stepId, branch),
      requestId,
      ...(dispatch ? { dispatch } : {}),
      ...placement,
    }, e.spawn));
  if (isTerminal(getRun(ctx, run.id))) {
    try { e.deps.stopTask(ctx, task.id); } catch { /* stopping must not throw into the engine */ }
    try { updateStep(ctx, key, { status: "stopped", error: "run stopped while delegating", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
    return updateStep(ctx, key, {});
  }
  return attachAndSettle(ctx, key, task.id, e);
}

async function startFanout(ctx: Ctx, run: RunRow, stepId: string, stepDef: FanoutStep, attempt: number, e: EngineOptions): Promise<StepRow> {
  const all = stepsOfRun(ctx, run.id);
  const orphans: StepRow[] = []; // active branch rows without a task id (a crash before their delegation)
  const fresh: string[] = []; // branches of the attempt with no row at all
  let first: StepRow | undefined;
  for (const branch of stepDef.branches) {
    const active = all.find(s => s.stepId === stepId && s.branch === branch && (s.status === "running" || s.status === "waiting"));
    if (!active) { fresh.push(branch); continue; }
    if (active.taskId) { first ??= active; continue; }
    orphans.push(active);
  }
  // ALL branch rows of the new attempt are inserted in one transaction before any
  // branch is delegated (the fireEdge pattern): a branch whose task settles inside
  // its own delegation call can then never evaluate the join — or stop a join:'any'
  // branch — while a later branch row of the attempt does not exist yet
  // (round 4 review).
  const inserted = fresh.length > 0 ? insertFanoutBranches(ctx, run.id, stepId, attempt, fresh) : [];
  first ??= inserted[0];
  const pending = new Map<string, StepRow>([...inserted, ...orphans].map(row => [row.branch!, row]));
  for (const branch of stepDef.branches) {
    const row = pending.get(branch);
    if (!row) continue; // an already-delegated branch: its task is in flight
    // A branch whose attempt already has a branch-less join row (a join 'any' that
    // resolved while an earlier branch settled inside its own delegation call) or
    // whose run went terminal while the loop was still walking the branches is not
    // delegated: its row is marked stopped and the branch skipped (round 5 review).
    const joined = stepsOfRun(ctx, run.id).some(s =>
      s.stepId === stepId && s.attempt === attempt && s.branch === undefined);
    if (joined || isTerminal(getRun(ctx, run.id))) {
      try { updateStep(ctx, keyOf(row), { status: "stopped", error: joined ? "join resolved while delegating" : "run stopped while delegating", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
      continue;
    }
    // An orphan row keeps its own attempt and request id: its task is attached when
    // it exists, or delegated without inserting a second row for the same key.
    const prior = taskByRequestId(ctx, stepRequestId(run.id, stepId, row.attempt, branch));
    const settledRow = prior
      ? await attachAndSettle(ctx, { runId: run.id, stepId, attempt: row.attempt, branch }, prior.id, e)
      : await delegateFanoutBranch(ctx, run, row, stepDef, e);
    first ??= settledRow;
  }
  return first!;
}

/** Reconciles one orphan step row (status running, no task id) outside a cursor gap
 *  (Review Focus: run correctness 2): the task reserved under the row's request id is
 *  attached, and settled at once when it is already terminal; when no task exists and
 *  the row is older than 60 seconds (the delegation it waited for is long gone), the
 *  step is delegated again under the same attempt and request id. Returns what it did. */
export async function reconcileOrphanStep(
  ctx: Ctx,
  row: StepRow,
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<"attached" | "redelegated" | "pending" | "skipped"> {
  const run = getRun(ctx, row.runId);
  if (!run || isTerminal(run)) return "skipped";
  const key: StepKey = { runId: row.runId, stepId: row.stepId, attempt: row.attempt, ...(row.branch !== undefined ? { branch: row.branch } : {}) };
  const prior = taskByRequestId(ctx, stepRequestId(row.runId, row.stepId, row.attempt, row.branch));
  if (prior) {
    await attachAndSettle(ctx, key, prior.id, { deps, spawn });
    return "attached";
  }
  if (ctx.now - row.startedAt < 60) return "pending"; // the delegation may still be in flight
  const def = loadDefinition(ctx, run);
  const stepDef = def?.steps[row.stepId];
  if (!def || !stepDef) return "skipped";
  if (stepDef.type === "fanout") {
    if (row.branch === undefined) return "skipped"; // a fan-out's branch-less row is its join marker, never a task
    // The row already exists: delegate it under its own attempt and request id
    // instead of inserting a second row for the same key.
    await delegateFanoutBranch(ctx, run, row, stepDef, { deps, spawn });
  } else if (stepDef.type === "agent") {
    // Orchestrator-role steps share one task; UNIQUE(task_id) leaves older rows
    // orphaned. Never startAgentStep them — that would delegate a real executor (I1).
    if (stepDef.role === "orchestrator") return "skipped";
    await startAgentStep(ctx, run, def, row.stepId, stepDef, row.branch, row.attempt, { deps, spawn });
  } else {
    return "skipped";
  }
  return "redelegated";
}

export type SeedFinished = {
  finishedIds: string[];
  results: Record<string, unknown>;
};

/**
 * Seeded finished ids reachable from `def.entry` by following only matched edges
 * whose targets are also finished. Unreachable seeded rows stay inert (already
 * stamped advancedAt) so a replan that drops old edges cannot fire stale successors.
 */
function reachableFinishedFromEntry(
  def: WorkflowDef,
  run: RunRow,
  finished: Set<string>,
  results: Record<string, unknown>,
): Set<string> {
  const reachable = new Set<string>();
  if (!finished.has(def.entry)) return reachable;
  const queue = [def.entry];
  reachable.add(def.entry);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const result = Object.prototype.hasOwnProperty.call(results, id) ? results[id] : {};
    for (const { edge } of matchedEdges(def, run, id, result)) {
      if (!finished.has(edge.to) || reachable.has(edge.to)) continue;
      reachable.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reachable;
}

/**
 * Seed finished steps from a prior child (replan) as done with their results,
 * stamp advancedAt on every seeded row, and resume from the unfinished frontier
 * of seeded rows still reachable from the entry through finished steps only.
 */
async function seedFinishedAndResume(
  ctx: Ctx,
  run: RunRow,
  def: WorkflowDef,
  seed: SeedFinished,
  e: EngineOptions,
): Promise<void> {
  const finished = new Set(seed.finishedIds.filter(id => def.steps[id] && def.steps[id]!.type !== "end"));
  if (finished.size === 0) {
    await startStep(ctx, run, def, def.entry, undefined, e);
    return;
  }
  const seededRows: StepRow[] = [];
  for (const id of finished) {
    const result = Object.prototype.hasOwnProperty.call(seed.results, id) ? seed.results[id] : {};
    const existing = stepsOfRun(ctx, run.id).find(s =>
      s.stepId === id && s.attempt === 1 && (s.branch ?? undefined) === undefined);
    let row: StepRow;
    if (existing) {
      row = existing.status === "done" && existing.advancedAt != null
        ? existing
        : updateStep(ctx, keyOf(existing), {
          status: "done", result, endedAt: existing.endedAt ?? ctx.now, advancedAt: ctx.now,
        });
    } else {
      try {
        const inserted = insertStep(ctx, { runId: run.id, stepId: id, attempt: 1, status: "done" });
        row = updateStep(ctx, keyOf(inserted), {
          status: "done", result, endedAt: ctx.now, advancedAt: ctx.now,
        });
      } catch (err) {
        // Concurrent seed apply: treat UNIQUE on the seed step key as already written.
        if (!/UNIQUE|unique|constraint/i.test(err instanceof Error ? err.message : String(err))) throw err;
        const again = stepsOfRun(ctx, run.id).find(s =>
          s.stepId === id && s.attempt === 1 && (s.branch ?? undefined) === undefined);
        if (!again) throw err;
        row = again;
      }
    }
    seededRows.push(row);
  }
  if (!finished.has(def.entry)) {
    await startStep(ctx, getRun(ctx, run.id)!, def, def.entry, undefined, e);
    return;
  }

  const back = backEdgeIndexes(def);
  const startedTargets = new Set<string>();
  let startedAny = false;
  let endReachable = false;
  const live = getRun(ctx, run.id) ?? run;
  const frontier = reachableFinishedFromEntry(def, live, finished, seed.results);
  const frontierRows = seededRows.filter(row => frontier.has(row.stepId));

  for (const row of frontierRows) {
    if (isTerminal(getRun(ctx, run.id))) return;
    const matched = matchedEdges(def, live, row.stepId, row.result);
    for (const { edge, index } of matched) {
      const target = def.steps[edge.to];
      if (!target) {
        await failRun(ctx, run.id, `unknown step '${edge.to}' after seeded ${row.stepId}`, undefined, e.deps);
        return;
      }
      if (target.type === "end") {
        endReachable = true;
        continue;
      }
      if (finished.has(edge.to) || startedTargets.has(edge.to)) continue;

      const outcome = fireEdge(ctx, {
        runId: run.id,
        from: { stepId: row.stepId, attempt: row.attempt, branch: row.branch },
        edgeIndex: index,
        stepId: edge.to,
        status: (target.type === "human" || target.type === "generate" || target.type === "choose_workflow")
          ? "waiting" : "running",
        ...(target.type === "fanout" ? { branches: target.branches } : {}),
        ...(back.has(index) ? { back: { key: `${edge.from}->${edge.to}`, maxLoops: edge.maxLoops ?? 0 } } : {}),
      });
      if (outcome.kind === "terminal") return;
      if (outcome.kind === "loop-limit") {
        await failRun(ctx, run.id, `loop limit ${edge.from}->${edge.to}`, outcome.loops, e.deps);
        return;
      }
      if (outcome.kind === "handled") {
        startedTargets.add(edge.to);
        startedAny = true;
        continue;
      }
      startedTargets.add(edge.to);
      startedAny = true;
      if (outcome.loops) await publishRunChange(ctx, getRun(ctx, run.id));
      const fresh = getRun(ctx, run.id)!;
      if (isTerminal(fresh)) return;
      try {
        if (target.type === "human") {
          const humanRow = outcome.rows[0];
          if (humanRow) startHumanWaiting(ctx, fresh, humanRow.stepId, humanRow.attempt, target, humanRow.branch);
          if (!isTerminal(getRun(ctx, run.id))) await patchRun(ctx, run.id, { status: "waiting" });
          continue;
        }
        if (target.type === "generate") {
          for (const fired of outcome.rows) {
            await startGenerateStep(ctx, fresh, fired.stepId, target, fired.attempt);
          }
          continue;
        }
        if (fresh.status === "waiting") {
          try { await patchRun(ctx, run.id, { status: "running" }); }
          catch (err) {
            if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
          }
        }
        for (const fired of outcome.rows) {
          if (target.type === "fanout") await delegateFanoutBranch(ctx, fresh, fired, target, e);
          else if (target.type === "agent" && target.role === "orchestrator") {
            await startOrchestratorRoleStep(ctx, fresh, def, fired.stepId, target, fired.attempt);
          } else if (target.type === "agent") await delegateAgentRow(ctx, fresh, fired, target, e);
          else if (target.type === "choose_workflow") {
            await startChooseWorkflowStep(ctx, fresh, fired.stepId, target, fired.attempt);
          } else {
            throw new CoreError("not_allowed", `step type '${(target as { type: string }).type}' is not started as a task here`);
          }
        }
      } catch (err) {
        await failRun(ctx, run.id, `start failed: ${edge.to}: ${err instanceof Error ? err.message : String(err)}`, undefined, e.deps);
        return;
      }
    }
  }

  if (startedAny || isTerminal(getRun(ctx, run.id))) return;
  if (endReachable) {
    await patchRun(ctx, run.id, { status: "done" });
    return;
  }
  await failRun(ctx, run.id, "replan seed has no unfinished frontier and no reachable end", undefined, e.deps);
}

/** Starts a run: creates the run record and starts its entry step. A failing start
 *  fails the run (never leaves it silently stuck) and rethrows. */
/**
 * Start def.entry (or apply a durable entry_seed) for a live, unpaused run.
 * Claims the entry lease atomically; existing steps without a pending seed, a
 * pending pause, or a lost claim are no-ops. Used after pacing/person resume and
 * on every tick (after the lease expires, recovers a crashed startRun).
 */
export async function startEntryIfNeeded(
  ctx: Ctx,
  runId: string,
  o?: StartOptions,
): Promise<boolean> {
  const run = getRun(ctx, runId);
  if (!run || RUN_TERMINAL.includes(run.status)) return false;
  if (isRunStepPaused(run)) {
    // Pause skip: drop a stale transient window so a later resume is not failed immediately.
    resetEntryStartAttempts(ctx, runId);
    return false;
  }
  const hasSeed = !!(run.entrySeed && run.entrySeed.finishedIds.length > 0);
  if (!hasSeed && stepsOfRun(ctx, runId).length > 0) return false;
  const owner = o?.entryOwner ?? newEntryOwner();
  const now = leaseNow(ctx);
  const until = now + entryLeaseSeconds(ctx);
  if (!claimEntryLease(ctx, runId, owner, until, now)) return false;
  const def = getDefinition(ctx, run.workflow);
  if (!def) {
    clearEntryLease(ctx, runId, owner);
    return false;
  }
  const held = await withEntryLease(ctx, runId, owner, async (ctl) => {
    if (o?.afterEntryClaim) await o.afterEntryClaim(ctx, runId);
    if (!ctl.renew()) return false;
    // Same harness fault delay as startRun so a tick recovery can outlast the lease (P15).
    const delayMs = startRunDelayMs(ctx);
    if (delayMs > 0) {
      await new Promise<void>(r => setTimeout(r, delayMs));
      if (!ctl.renew()) return false;
    }
    // Crash between insertRun and ensureRootWorkNode: recover the root before entry.
    const live = getRun(ctx, runId)!;
    if (isWorkNodeRun(live)) ensureRootWorkNode(ctx, live);
    if (hasSeed) {
      if (!ctl.renew()) return false;
      await seedFinishedAndResume(ctx, getRun(ctx, runId)!, def, run.entrySeed!, withDefaults(o));
      if (ctl.lost()) return false;
      clearEntrySeed(ctx, runId);
      resetEntryStartAttempts(ctx, runId);
      return true;
    }
    if (def.steps[def.entry]?.type === "end") {
      await patchRun(ctx, runId, { status: "done" }, withDefaults(o));
      resetEntryStartAttempts(ctx, runId);
      return true;
    }
    if (!ctl.renew()) return false;
    await startStep(ctx, getRun(ctx, runId)!, def, def.entry, undefined, o);
    if (ctl.lost()) return false;
    resetEntryStartAttempts(ctx, runId);
    return true;
  });
  if (held.error) {
    const e = held.error;
    if (e instanceof CoreError && e.code === "not_allowed" && String(e.message).includes("is paused")) {
      resetEntryStartAttempts(ctx, runId);
      return false;
    }
    // Another starter won the ENTRY step insert — healthy run, not a failure (B1).
    if (isEntryStepAlreadyStarted(e, runId, def.entry)) {
      resetEntryStartAttempts(ctx, runId);
      return true;
    }
    // Lost lease mid-start: stop cleanly; never failRun a healthy run for it.
    if (held.leaseLost) return false;
    throw e;
  }
  return held.value === true;
}

export type StartPendingOptions = StartOptions & {
  /** Limit to this run and its live descendants (run.resume). */
  rootRunId?: string;
  /**
   * When false (run.resume), do not consume the durable transient budget — the tick
   * still counts. Default true for tick / recovery paths.
   */
  countTransient?: boolean;
};

/** After pacing clears, start entry for every live unpaused run that still needs it. */
export async function startPendingEntries(
  ctx: Ctx,
  o?: StartPendingOptions,
): Promise<number> {
  let started = 0;
  for (const run of liveRunsNeedingEntry(ctx, { rootRunId: o?.rootRunId, now: leaseNow(ctx) })) {
    try {
      if (await startEntryIfNeeded(ctx, run.id, o)) started++;
    } catch (e) {
      if (isTransientError(e)) {
        if (o?.countTransient === false) continue;
        let attempts = 0;
        let firstAt = leaseNow(ctx);
        try {
          const recorded = bumpEntryStartAttempts(ctx, run.id, leaseNow(ctx));
          attempts = recorded.attempts;
          firstAt = recorded.firstAt;
        } catch (bumpErr) {
          console.warn(
            `pacer: bumpEntryStartAttempts failed for ${run.id}: ${
              bumpErr instanceof Error ? bumpErr.message : String(bumpErr)
            }`,
          );
          continue;
        }
        const elapsed = leaseNow(ctx) - firstAt;
        if (elapsed < ENTRY_START_TRANSIENT_MIN_S && attempts < ENTRY_START_TRANSIENT_MAX) continue;
        try {
          await failRun(
            ctx,
            run.id,
            `entry start failed after ${elapsed.toFixed(1)}s (${attempts} transient errors): ${
              e instanceof Error ? e.message : String(e)
            }`,
            undefined,
            o?.deps,
          );
        } catch { /* next tick retries failRun itself */ }
        continue;
      }
      // ENTRY PK collision: another starter already started — never failRun (B1).
      if (isEntryStepAlreadyStarted(e, run.id, getDefinition(ctx, run.workflow)?.entry ?? "")) {
        started++;
        continue;
      }
      try {
        await failRun(ctx, run.id, `entry start failed: ${e instanceof Error ? e.message : String(e)}`, undefined, o?.deps);
      } catch { /* next tick retries failRun itself */ }
    }
  }
  return started;
}

export async function startRun(
  ctx: Ctx,
  input: { workflow: string; repo: string; brief: string; title?: string; priority?: RunPriority; publish?: "draft"; origin?: string },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
  child?: {
    parentRunId: string;
    parentStep: string;
    planner?: string;
    orchestratorTaskId?: string;
    sessionId?: string;
    seedFinished?: SeedFinished;
    priority?: RunPriority;
    /** Generate/replan children of an already-running tree skip the live gate. */
    skipLiveGate?: boolean;
    /** A chosen child inherits the root's `publish: draft`. */
    publishOptIn?: "draft";
  },
): Promise<RunRow> {
  // `auto` is not a definition id: it starts the configured router (workflows.router,
  // default in strategy) whose choose_workflow step picks an installed workflow.
  let workflowRef = input.workflow;
  if (!child && workflowRef === "auto") {
    try {
      workflowRef = workflowRouterId(ctx);
    } catch (err) {
      // Missing strategy falls back inside workflowRouterId; only a broken file reaches here.
      if (err instanceof StrategyError) {
        throw new CoreError(
          "invalid_input",
          `run.start auto: cannot load strategy (${err.message})`,
        );
      }
      throw err;
    }
    if (!getDefinition(ctx, workflowRef)) {
      throw new CoreError(
        "not_found",
        `workflows.router '${workflowRef}' is not installed (run.start auto)`,
      );
    }
  }
  const def = getDefinition(ctx, workflowRef);
  if (!def) throw new CoreError("not_found", `unknown workflow '${workflowRef}'`);
  // Choose targets are fresh definitions and must pass the gate (chooseWorkflow also
  // checks before claim). Only generate/replan children set skipLiveGate for the
  // already-running parent's pinned run tree.
  if (!child?.skipLiveGate) {
    assertDefinitionStartAllowed(ctx, workflowRef);
  }
  if (typeof input.brief !== "string" || !input.brief.trim()) throw new CoreError("invalid_input", "brief is required");
  if (typeof input.repo !== "string" || !input.repo) throw new CoreError("invalid_input", "repo is required");
  if (input.publish !== undefined && input.publish !== "draft") {
    throw new CoreError("invalid_input", "publish must be 'draft' when set");
  }
  const budget = child ? undefined : budgetForDefinition(def);
  // Generated/choose children inherit the parent's pinned step mode (plain vs work_node).
  const parent = child ? getRun(ctx, child.parentRunId) : null;
  const parentStepMode = parent?.stepMode;
  const priority = child
    ? (child.priority ?? runPriorityOf(parent))
    : (input.priority ?? "normal");
  // Child runs inherit the root's notification owner: the parent already carries
  // the root's origin (children inherit at their own start), so no deeper walk.
  const origin = child ? parent?.origin : input.origin;
  // Inherit a parent person pause so a child STARTED after the pause is also paused.
  // insertRun also re-checks the parent inside its immediate txn (M3).
  const inheritPersonPause = !!(child && parent && isPersonPaused(parent));
  const entryOwner = newEntryOwner();
  const seed = child?.seedFinished && child.seedFinished.finishedIds.length > 0
    ? child.seedFinished
    : undefined;
  const leaseAtInsert = leaseNow(ctx);
  const leaseS = entryLeaseSeconds(ctx);
  const run = insertRun(ctx, {
    workflow: def.id,
    version: def.version,
    repo: input.repo,
    brief: input.brief,
    title: input.title,
    priority,
    ...(origin ? { origin } : {}),
    entryLeaseUntil: leaseAtInsert + leaseS,
    entryOwner,
    ...(seed ? { entrySeed: seed } : {}),
    ...(inheritPersonPause ? { pausedReason: "person" as const } : {}),
    ...(budget ? {
      budget: serializeBudget(budget),
      spent: serializeSpent({ orchestratorTurns: 0, messageTurns: 0 }),
    } : {}),
    ...(child ? {
      parentRunId: child.parentRunId,
      parentStep: child.parentStep,
      planner: child.planner,
      orchestratorTaskId: child.orchestratorTaskId,
      sessionId: child.sessionId,
      ...(parentStepMode ? { stepMode: parentStepMode } : {}),
    } : {}),
  });
  if (child ? child.publishOptIn === "draft" : input.publish === "draft") setPublishOptIn(ctx, run.id, "draft");
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run); // clients see the run even when its start then fails
  const held = await withEntryLease(ctx, run.id, entryOwner, async (ctl) => {
    ctl.renew();
    let live = getRun(ctx, run.id)!;
    // Apply mode-driven pause before the entry step so strict/emergency never
    // starts a background (or normal) step that should already be paused.
    // Person pause (including inherited) is left alone by syncRunPacingPause.
    try {
      const mode = await readPacingMode(ctx);
      if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
      live = syncRunPacingPause(ctx, live, mode);
    } catch { /* mode read must not fail start */ }
    if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
    // Live/sandbox fault: hold start past the lease so a concurrent tick races renewals.
    const delayMs = startRunDelayMs(ctx);
    if (delayMs > 0) {
      await new Promise<void>(r => setTimeout(r, delayMs));
      if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
    }
    if (isWorkNodeRun(live)) ensureRootWorkNode(ctx, live);
    if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
    live = getRun(ctx, run.id)!;
    // Pause before seed (same order as startEntryIfNeeded): a person/pacing-paused
    // seeded child must not fireEdge/delegate until resume; seed stays durable.
    if (isRunStepPaused(live)) {
      // Mode/person pause at start: keep the run, start no entry/seed work.
      // Drop any stale transient window so resume is not failed immediately.
      resetEntryStartAttempts(ctx, run.id);
    } else if (def.steps[def.entry]?.type === "end") {
      await patchRun(ctx, run.id, { status: "done" });
    } else if (seed) {
      if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
      await seedFinishedAndResume(ctx, getRun(ctx, run.id)!, def, seed, { deps, spawn });
      if (ctl.lost()) return getRun(ctx, run.id) ?? run;
      ctl.renew();
      clearEntrySeed(ctx, run.id);
    } else {
      if (!ctl.renew()) return getRun(ctx, run.id) ?? run;
      await startStep(ctx, getRun(ctx, run.id)!, def, def.entry, undefined, { deps, spawn });
      if (ctl.lost()) return getRun(ctx, run.id) ?? run;
      ctl.renew();
    }
    return getRun(ctx, run.id) ?? run;
  });
  if (held.error) {
    const e = held.error;
    // A pause refusal is not a failed start — the run stays live without a step.
    if (e instanceof CoreError && e.code === "not_allowed" && String(e.message).includes("is paused")) {
      return getRun(ctx, run.id) ?? run;
    }
    // Tick/resume already started entry while our lease lapsed — healthy, not failRun (B1).
    if (isEntryStepAlreadyStarted(e, run.id, def.entry)) {
      clearEntrySeed(ctx, run.id);
      return getRun(ctx, run.id) ?? run;
    }
    // Another owner claimed the lease (or renew unknown) — stop; do not failRun.
    if (held.leaseLost) return getRun(ctx, run.id) ?? run;
    await failRun(ctx, run.id, `start failed: ${e instanceof Error ? e.message : String(e)}`, undefined, deps);
    throw e;
  }
  // Re-read after withEntryLease finally cleared our owner-matched lease.
  const finished = getRun(ctx, run.id) ?? held.value ?? run;
  if (RUN_TERMINAL.includes(finished.status) && finished.parentRunId && finished.parentStep) {
    await settleParentChooseStep(ctx, finished, deps, spawn);
  }
  return finished;
}

/** Child step results keyed as `steps.<id>.result` for the parent generate/choose step. */
function childStepResults(ctx: Ctx, childId: string): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const s of stepsOfRun(ctx, childId)) {
    if (s.branch !== undefined) continue;
    if (s.result === undefined) continue;
    steps[s.stepId] = s.result;
  }
  return steps;
}

/** When a child run of choose_workflow/generate ends, finish the parent step with the child's result. */
export async function settleParentChooseStep(
  ctx: Ctx,
  child: RunRow,
  deps: EngineDeps,
  spawn?: SpawnRunner,
): Promise<void> {
  if (!child.parentRunId || !child.parentStep) return;
  const parent = getRun(ctx, child.parentRunId);
  if (!parent || RUN_TERMINAL.includes(parent.status)) return;
  const def = loadDefinition(ctx, parent);
  if (!def) return;
  // A child that kept a branch of its own hands it over before anything depends on
  // it. Until that merges, the generate step keeps waiting (the tick tries again).
  if (def.steps[child.parentStep]?.type === "generate" && !await adoptGeneratedBranches(ctx, parent)) return;
  const waiting = stepsOfRun(ctx, parent.id).filter(s => s.stepId === child.parentStep && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) return;
  // Ignore children that are not the live stamped child (replan cleared childRunId, or stale).
  // During startRun a child may finish before childRunId is stamped; choosing:true covers that window.
  const stamped = chooseStepChildRunId(row.result);
  if (stamped !== undefined && stamped !== child.id) return;
  if (stamped === undefined) {
    const choosing = row.result != null && typeof row.result === "object"
      && (row.result as { choosing?: unknown }).choosing === true;
    if (!choosing) return;
  }
  const prior = row.result != null && typeof row.result === "object"
    ? { ...(row.result as Record<string, unknown>) }
    : {};
  const result = {
    ...prior,
    workflow: child.workflow,
    reason: typeof prior.reason === "string" ? prior.reason : "",
    child: { id: child.id, status: child.status, reason: child.reason },
    steps: childStepResults(ctx, child.id),
    // The step's result is the child's: edges read `result.status`.
    status: child.status,
  };
  if (child.status === "stopped") {
    updateStep(ctx, keyOf(row), {
      status: "stopped",
      error: child.reason ?? "stopped",
      endedAt: ctx.now,
      result,
    });
    return;
  }
  if (child.status !== "done") {
    // Mark the choose/generate step failed and wake the root orchestrator —
    // unless the parent is mid-failRun cascade (children fail before the parent
    // patches), when a step_failed wake would only noise a dying run (M4).
    const failed = updateStep(ctx, keyOf(row), {
      status: "failed",
      error: child.reason ?? child.status,
      endedAt: ctx.now,
      result,
    });
    if (!failingRuns.has(parent.id)) {
      enqueueWakeup(ctx, {
        runId: parent.id,
        cause: "step_failed",
        ref: stepWakeRef(failed.runId, failed.stepId, failed.attempt, failed.branch),
        createdAt: ctx.now,
      });
    }
    return;
  }
  const claimed = claimStepAnswer(ctx, keyOf(row), result);
  if (!claimed) return;
  await advanceFrom(ctx, parent.id, def, claimed, result, { deps, spawn });
}

function resultErrors(result: unknown, schema: StepResultSchema | undefined, ctx: Ctx, runId: string): string[] {
  if (schema === "evidence") return validateEvidenceResult(ctx, runId, result);
  if (!isPlainObject(result)) return ["result must be a JSON object"];
  const lite = schema as JsonSchemaLite | undefined;
  return (lite?.required ?? []).filter(key => !Object.hasOwn(result, key)).map(key => `missing required key '${key}'`);
}

/** Collect runner-advertised evidence tools (D9). Missing config → empty set. */
function advertisedEvidenceTools(ctx: Ctx): ReadonlySet<EvidenceNeed> {
  try {
    const strategy = loadStrategy(ctx);
    const out = new Set<EvidenceNeed>();
    for (const runner of Object.values(strategy.runners ?? {})) {
      if (runner.enabled === false) continue;
      for (const tool of runner.tools ?? []) {
        if (tool === "browser" || tool === "desktop" || tool === "tui") out.add(tool);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Records an agent step's structured result before settlement. Validated at once
 *  against the step's declared schema so the agent can fix it in the same turn
 *  (spec, "Returning a step result"). Serialized results are capped at 64 KiB so
 *  every transport stays inside its body limits. */
export function recordStepResult(ctx: Ctx, taskId: string, result: unknown): StepRow {
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} is not a workflow step`);
  // A task resumed after its step parked for review replaces the earlier report.
  if (!resumedForFollowUp(ctx, step)) {
    if (step.status !== "running") throw new CoreError("conflict", `conflict: step ${step.stepId} is not running`);
    if (step.result !== undefined) throw new CoreError("conflict", `conflict: step ${step.stepId} already has a result`);
  }
  const run = getRun(ctx, step.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${step.runId}`);
  const stepDef = loadDefinition(ctx, run)?.steps[step.stepId];
  const schema = stepDef?.type === "agent" ? stepDef.result : stepDef?.type === "fanout" ? stepDef.each.result : undefined;
  const serialized = JSON.stringify(result);
  // The cap is on UTF-8 bytes, matching the message: a multibyte result can pass a
  // character count while still exceeding the transport's byte limits.
  const bytes = Buffer.byteLength(serialized ?? "", "utf8");
  if (bytes > 64 * 1024) {
    throw new CoreError("invalid_input", `result is ${bytes} bytes; the limit is ${64 * 1024}`);
  }
  const errors = resultErrors(result, schema, ctx, run.id);
  if (errors.length > 0) throw new CoreError("invalid_input", errors.join("; "));
  return updateStep(ctx, keyOf(step), { result });
}

/** Settles the step instance a task belongs to and advances its run. A no-op when
 *  the task has no step row, the task is not settled yet, or the step already
 *  settled (Review Focus 1 and 3). The settlement itself is claimed atomically in
 *  the store (claimStepSettlement), so the tick thread and the request thread can
 *  both observe the same settled task and only one of them advances the run. */
export async function onTaskSettled(ctx: Ctx, taskId: string, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<void> {
  const step = stepByTask(ctx, taskId);
  if (!step) return;
  const run = getRun(ctx, step.runId);
  if (!run) return;
  const task = readTask(ctx, taskId);
  if (!task) return;
  const def = loadDefinition(ctx, run);
  if (!def) return;
  if (awaitsReview(ctx, step, def)) {
    await settleReview(ctx, run, def, step, { deps, spawn });
    return;
  }
  if (!SETTLE_STATES.includes(task.state)) return;
  if (step.status !== "running") return;
  // One yield before the claim: a concurrent settlement (the request thread's
  // attach path and the tick, say) can then read the row as still running too, and
  // it is the claim below — not the luck of synchronous execution — that makes the
  // settlement exclusive and the run advanced exactly once (Review Focus 6).
  await Promise.resolve();
  const done = task.state === "done" && step.result !== undefined;
  // A turn that ends on a blocking question holds the step until the answer arrives.
  if (!done && task.state === "done" && isOrchestratorStep(def, step) && heldByQuestion(ctx, step)) {
    if (claimStepSettlement(ctx, keyOf(step), { status: "waiting" })) {
      await markRunWaiting(ctx, run.id);
      await publishRunChange(ctx, getRun(ctx, run.id) ?? run);
    }
    return;
  }
  // choose_workflow may start a child whose first step is role:orchestrator and attaches
  // the shared orch task mid-turn. The choosing turn then settles done without a result for
  // that new step. If an unclaimed orchestrator_step wakeup still exists for it, requeue
  // instead of "no step result" so a fresh root turn can drive the child step (W4b ask).
  if (!done && task.state === "done") {
    const rootId = rootRunId(ctx, run.id);
    const ref = stepWakeRef(step.runId, step.stepId, step.attempt, step.branch);
    const pendingOrch = workflowDatabase(ctx).query(
      "SELECT 1 AS ok FROM workflow_wakeups WHERE run_id = ? AND cause = ? AND ref = ? AND done_at IS NULL AND turn_id IS NULL LIMIT 1",
    ).get(rootId, "orchestrator_step", ref) as { ok: number } | null;
    if (pendingOrch) {
      updateTask(ctx, taskId, t => {
        if (SETTLE_STATES.includes(t.state)) {
          t.state = "queued";
          delete t.result;
          delete t.settledAt;
          delete t.queue;
          delete t.reviewRequest;
          delete t.progress;
          delete t.runnerPid;
        }
      });
      // The choosing turn already fulfilled its wake-ups; leave it running and the
      // unclaimed child wakeup can never claim a new turn (live W4b hang).
      // Own THIS root's turn for the settled task only: a foreign live turn on the
      // shared orch task (child run) must not be settled by this path (I3 race).
      const turn = liveTurnForTask(ctx, taskId, rootId);
      if (turn && (turn.status === "running" || turn.status === "starting")) {
        await settleTurn(ctx, turn.id, { outcome: "done" });
      }
      return;
    }
  }
  const error = done ? undefined : task.state === "done" ? "no step result" : task.state;
  // A finished code step waits for the verdict that merges it (B8).
  const review = done && !isTerminal(getRun(ctx, run.id)) && needsReview(ctx, def, step);
  const claimed = claimStepSettlement(ctx, keyOf(step), review
    ? { status: "waiting" }
    : done ? { status: "done", endedAt: ctx.now } : { status: "failed", error, endedAt: ctx.now });
  if (!claimed) return; // another caller settled this step: the run advances exactly once
  const row = claimed;
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run); // every settlement publishes the run
  if (isTerminal(getRun(ctx, run.id))) return; // A terminal run only records the bookkeeping.
  if (review) {
    await openReview(ctx, run, def, row, { deps, spawn });
    return;
  }
  const stepDef = def.steps[step.stepId];
  if (stepDef?.type === "fanout") {
    await joinFanout(ctx, run, def, step, stepDef, { deps, spawn });
    return;
  }
  if (row.status === "failed") {
    await handleStepFailure(ctx, run, row, deps);
    return;
  }
  await advanceFrom(ctx, run.id, def, row, row.result, { deps, spawn, settleLiveOrchTurn: true });
}

function isOrchestratorStep(def: WorkflowDef, row: StepRow): boolean {
  const step = def.steps[row.stepId];
  return step?.type === "agent" && step.role === "orchestrator";
}

/** A failed agent step is a decision point: replan a generated child, else wake the
 *  orchestrator. */
async function handleStepFailure(ctx: Ctx, run: RunRow, step: StepRow, deps: EngineDeps): Promise<void> {
  // Generated child: replan policy may take the failure instead of a plain step_failed wake.
  if (run.parentRunId && run.parentStep) {
    const { noteChildStepFailureForReplan } = await import("./replan");
    const noted = noteChildStepFailureForReplan(ctx, run.id, step.stepId);
    if (noted) {
      if (noted.opened) {
        // Park the failed child after childRunId was cleared so settlement is a no-op.
        try {
          const live = getRun(ctx, run.id);
          if (live && !RUN_TERMINAL.includes(live.status)) {
            await stopRun(ctx, run.id, live.rev, deps);
          }
        } catch { /* child may already be terminal */ }
      }
      return;
    }
  }
  // Decision point: wake the orchestrator instead of ending the run (Phase 2).
  // Mechanical failures (no edge, loop limit, start failure) still use failRun.
  // Child runs share the root orchestrator: wake-ups are always keyed by root.
  const cause = step.error === "no step result" ? "step_invalid" as const : "step_failed" as const;
  enqueueWakeup(ctx, {
    runId: run.id,
    cause,
    ref: stepWakeRef(step.runId, step.stepId, step.attempt, step.branch),
    createdAt: ctx.now,
  });
  await markRunWaiting(ctx, run.id);
}

async function markRunWaiting(ctx: Ctx, runId: string): Promise<void> {
  if (!isTerminal(getRun(ctx, runId)) && getRun(ctx, runId)?.status === "running") {
    try { await patchRun(ctx, runId, { status: "waiting" }); }
    catch { /* concurrent terminal/waiting is fine */ }
  }
}

/** A step just parked for review: act on a verdict that already landed, else wake
 *  the orchestrator to give one (the person can too, from attention). */
async function openReview(ctx: Ctx, run: RunRow, def: WorkflowDef, row: StepRow, e: EngineOptions): Promise<void> {
  const task = readTask(ctx, row.taskId!);
  if (task?.review || task?.retriedBy) {
    await settleReview(ctx, run, def, row, e);
    return;
  }
  ensureOrchestratorTask(ctx, getRun(ctx, rootRunId(ctx, run.id))!);
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "review_due",
    ref: stepWakeRef(row.runId, row.stepId, row.attempt, row.branch),
    createdAt: ctx.now,
  });
  await markRunWaiting(ctx, run.id);
}

/**
 * Moves a step that waits for review once something decided it: a retry takes the
 * step over, a task that ended unsuccessfully or was rejected fails it, and an
 * accept whose work is on the run branch finishes it. Anything else keeps waiting.
 */
async function settleReview(ctx: Ctx, run: RunRow, def: WorkflowDef, row: StepRow, e: EngineOptions): Promise<void> {
  if (isTerminal(getRun(ctx, run.id))) return;
  const task = readTask(ctx, row.taskId!);
  if (!task) return;
  const ref = stepWakeRef(row.runId, row.stepId, row.attempt, row.branch);
  if (task.retriedBy) {
    await adoptStepRetry(ctx, row, task.retriedBy, e);
    return;
  }
  // Running again after a send-back, or asking: nothing to decide yet.
  if (!SETTLE_STATES.includes(task.state) && !(task.state === "partial" && task.review)) return;
  let error: string | undefined;
  if (!task.review) {
    if (task.state === "done") return;
    error = `review: task ${task.state}`;
  } else if (!task.review.accepted) error = REVIEW_REJECTED;
  else {
    // Edges fire only after a clean merge. An accept merges before it is recorded;
    // this covers a verdict recorded any other way. A refused merge keeps waiting.
    try {
      if (!await taskWorkMerged(ctx, task.id)) {
        const merge = await mergeTaskOnAccept(ctx, task.id);
        if (merge && !merge.merged) return;
      }
    } catch (err) {
      console.warn(`pacer: run ${run.id} step ${row.stepId} is accepted but not merged: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
  const claimed = claimStepReview(ctx, keyOf(row), task.id, error === undefined
    ? { status: "done", endedAt: ctx.now }
    : { status: "failed", error, endedAt: ctx.now });
  if (!claimed) return; // another caller settled this step: the run advances exactly once
  completeWakeupRef(ctx, run.id, "review_due", ref);
  // A step that failed here no longer stands behind a merge conflict it raised.
  pruneAbandonedConflicts(ctx, run.id);
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run);
  const stepDef = def.steps[row.stepId];
  if (claimed.status === "failed") {
    // A rejected fan-out branch is a decision like any failed step; its join
    // waits for the retry or the skip.
    if (claimed.branch !== undefined && fanoutJoined(stepsOfRun(ctx, run.id), claimed)) {
      closeHeldBranch(ctx, claimed);
      return;
    }
    await handleStepFailure(ctx, getRun(ctx, run.id)!, claimed, e.deps);
    return;
  }
  if (stepDef?.type === "fanout") {
    await joinFanout(ctx, getRun(ctx, run.id)!, def, claimed, stepDef, e);
    return;
  }
  await advanceFrom(ctx, run.id, def, claimed, claimed.result, e);
}

/** A parked step whose task was retried without the commit moving it (a retry
 *  made before this service version): the successor takes it over now. */
async function adoptStepRetry(ctx: Ctx, row: StepRow, successorId: string, e: EngineOptions): Promise<void> {
  if (!readTask(ctx, successorId) || !adoptRetriedStep(ctx, row.taskId!, successorId)) return;
  completeWakeupRef(ctx, row.runId, "review_due", stepWakeRef(row.runId, row.stepId, row.attempt, row.branch));
  const run = getRun(ctx, row.runId);
  if (!run) return;
  await publishRunChange(ctx, run);
  const successor = readTask(ctx, successorId);
  if (successor && SETTLE_STATES.includes(successor.state)) await onTaskSettled(ctx, successorId, e.spawn, e.deps);
}

/** Evaluates the join rule across a fan-out attempt's branches; a resolved join is
 *  recorded as the attempt's branch-less row, which is both the joined result and
 *  the marker that the fan-out already advanced. Exported for the tick's recovery
 *  of a fan-out whose join evaluation was lost to a lock error.
 *
 *  The join is evaluated over the definition's branches: a branch whose row does
 *  not exist yet (a start still inserting the attempt) counts as still running, so
 *  a fast-settling first branch never joins — or stops a join:'any' branch — while
 *  a later branch of the attempt has not even started (round 4 review). */
export async function joinFanout(ctx: Ctx, run: RunRow, def: WorkflowDef, settled: StepRow, stepDef: FanoutStep, e: EngineOptions): Promise<void> {
  const attempt = fanoutAttempt(settled);
  const rows = stepsOfRun(ctx, run.id).filter(s => s.stepId === settled.stepId && fanoutAttempt(s) === attempt);
  const join = rows.find(s => s.branch === undefined);
  if (join && (join.status === "done" || join.status === "failed")) return;
  // The latest row of each branch speaks for it (a retry replaces the failed one).
  const byBranch = new Map([...rows].sort((a, b) => a.attempt - b.attempt)
    .filter(s => s.branch !== undefined).map(s => [s.branch!, s]));
  const done: StepRow[] = [];
  const failed: StepRow[] = [];
  const running: StepRow[] = [];
  const branchless: string[] = []; // definition branches whose row does not exist yet: still starting
  for (const branch of stepDef.branches) {
    const row = byBranch.get(branch);
    if (!row) { branchless.push(branch); continue; }
    if (row.status === "done") done.push(row);
    // A branch the review rejected still owes a retry or a skip: it neither
    // satisfies nor fails the join.
    else if (isHeldBranch(row)) running.push(row);
    else if (row.status === "failed") failed.push(row);
    else if (row.status === "running" || row.status === "waiting") running.push(row);
    // stopped rows are already out of the attempt (a concurrent failRun stopped them)
  }
  let outcome: "done" | "failed" | null = null;
  if (stepDef.join === "all") outcome = failed.length > 0 ? "failed" : running.length === 0 && branchless.length === 0 ? "done" : null;
  else if (stepDef.join === "any") outcome = done.length > 0 ? "done" : running.length + branchless.length === 0 ? "failed" : null;
  else {
    const quorum = stepDef.join.quorum;
    if (done.length >= quorum) outcome = "done";
    else if (done.length + running.length + branchless.length < quorum) outcome = "failed";
  }
  if (!outcome) return;
  if (stepDef.join === "any" && outcome === "done") {
    for (const b of running) {
      if (!b.taskId || isHeldBranch(b)) continue;
      const parked = awaitsReview(ctx, b, def);
      stopStepTask(ctx, b, e.deps);
      if (parked) {
        // The join no longer waits for its verdict.
        updateStep(ctx, keyOf(b), { status: "stopped", error: "join resolved", endedAt: ctx.now });
        completeWakeupRef(ctx, run.id, "review_due", stepWakeRef(b.runId, b.stepId, b.attempt, b.branch));
      }
    }
  }
  const branches = Object.fromEntries(stepDef.branches.map(b => [b, byBranch.get(b)?.result ?? null]));
  // Surface a joined verdict for edge conditions (design: result.verdict on fan-out).
  // Compute over DONE branches only (stopped/failed/missing are ignored for the
  // token). Any "revise" among those wins even if other done branches lack a
  // verdict. Mixed pass+ok collapses to "pass". Join any/quorum still uses the
  // join outcome above; a failed join fails the run regardless of verdicts.
  const doneVerdicts = done.map(row => {
    const r = row.result;
    if (r != null && typeof r === "object" && !Array.isArray(r) && typeof (r as { verdict?: unknown }).verdict === "string") {
      return (r as { verdict: string }).verdict;
    }
    return null;
  });
  let verdict: string | undefined;
  if (doneVerdicts.some(v => v === "revise")) verdict = "revise";
  else {
    const tokens = doneVerdicts.filter((v): v is string => v != null);
    if (tokens.length > 0) {
      if (tokens.every(v => v === "pass" || v === "ok")) {
        verdict = tokens.some(v => v === "pass") ? "pass" : "ok";
      }
    }
  }
  const result = {
    branches,
    done: done.length,
    failed: failed.length,
    ...(verdict !== undefined ? { verdict } : {}),
  };
  // One yield before the join row: a concurrent join of the same attempt (the
  // change loop racing the tick's recovery, say) computes the same outcome, and the
  // INSERT OR IGNORE below — not the luck of synchronous execution — decides which
  // caller advances the run (round 4 review).
  await Promise.resolve();
  const joinRow = insertJoinStep(ctx, run.id, settled.stepId, attempt, outcome, result);
  if (!joinRow) return; // the concurrent join inserted the row and owns the advancement
  pruneAbandonedConflicts(ctx, run.id);
  // A rejected branch the join no longer needs owes no decision.
  for (const held of running.filter(isHeldBranch)) closeHeldBranch(ctx, held);
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run); // the join publishes the run
  if (outcome === "failed") {
    await failRun(ctx, run.id, `step ${settled.stepId} ${failed[0]?.error ?? "failed"}`, undefined, e.deps);
    return;
  }
  await advanceFrom(ctx, run.id, def, joinRow, result, e);
}

function closeHeldBranch(ctx: Ctx, row: StepRow): void {
  updateStep(ctx, keyOf(row), { advancedAt: ctx.now });
  clearStepFailureWakeups(ctx, row);
}

/** Follows a finished step's outgoing edges: every edge whose `when` holds (an edge
 *  without one always fires) starts its target; a back edge counts against
 *  `maxLoops`; no match or an exceeded loop fails the run; an `end` target ends it.
 *  With several matched edges the ordinary targets start first (in edge order) and
 *  the end target is evaluated last, and only when no branch-less step row of the
 *  run is still running or waiting and no fan-out of the run is unresolved (Review
 *  Focus: run correctness 9).
 *
 *  Each ordinary edge fires through the store's trigger transaction (fireEdge):
 *  the successor row, the back-edge loop patch and the edge's trigger land in one
 *  transaction, and an edge whose trigger already exists is skipped — so a
 *  concurrent or replayed advancement can neither re-increment a loop counter nor
 *  start a successor twice (Review Focus: run correctness 8). A skipped edge still
 *  counts as started, so a replay never evaluates the end edges the original pass
 *  dropped (round 4 review), and fireEdge re-checks inside its transaction that the
 *  run is still live, so a stop landing in between leaves no successor behind.
 *  Delegation happens after the transaction. The end decision and failRun are
 *  naturally idempotent and stay outside it. Once every edge is decided, the step
 *  row records `advanced_at`, the "nothing left to do" marker the tick's re-advance
 *  query reads. */
async function advanceFrom(ctx: Ctx, runId: string, def: WorkflowDef, settled: StepRow, result: unknown, e: EngineOptions): Promise<void> {
  const run = getRun(ctx, runId);
  if (isTerminal(run)) return;
  // Pause at step boundaries: the settled step stays done; leave advanced_at unset
  // so the tick re-advances once the pause clears.
  if (run && isRunStepPaused(run)) return;
  const stepId = settled.stepId;
  // One yield before the edges fire: concurrent advancements (a settlement racing a
  // tick re-advance, say) then both decide from the same state, and it is the
  // trigger transaction below — not the luck of synchronous execution — that keeps
  // each edge single-fire.
  await Promise.resolve();
  // Marks the step row advanced, best effort: a failure leaves the row for the
  // tick's re-advance, which replays the same (idempotent) decision.
  const markAdvanced = (): void => {
    try { updateStep(ctx, keyOf(settled), { advancedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
  };
  const back = backEdgeIndexes(def);
  const matched = matchedEdges(def, run!, stepId, result);
  if (matched.length === 0) {
    await failRun(ctx, runId, `no edge matched after ${stepId}`, undefined, e.deps);
    markAdvanced();
    return;
  }
  const ends: typeof matched = [];
  const nexts: typeof matched = [];
  for (const match of matched) {
    const target = def.steps[match.edge.to];
    if (!target) {
      await failRun(ctx, runId, `unknown step '${match.edge.to}' after ${stepId}`, undefined, e.deps);
      markAdvanced();
      return;
    }
    (target.type === "end" ? ends : nexts).push(match);
  }
  let started = false;
  for (const { edge, index } of nexts) {
    const current = getRun(ctx, runId);
    if (isTerminal(current)) return; // another edge's settle or a stop ended the run
    const target = def.steps[edge.to]!;
    const waitingTarget = target.type === "human" || target.type === "generate" || target.type === "choose_workflow";
    const outcome = fireEdge(ctx, {
      runId,
      from: { stepId: settled.stepId, attempt: settled.attempt, branch: settled.branch },
      edgeIndex: index,
      stepId: edge.to,
      status: waitingTarget ? "waiting" : "running",
      ...(target.type === "fanout" ? { branches: target.branches } : {}),
      ...(back.has(index) ? { back: { key: `${edge.from}->${edge.to}`, maxLoops: edge.maxLoops ?? 0 } } : {}),
    });
    if (outcome.kind === "handled") {
      // An already-fired edge still owns the run's continuation: the original pass
      // may have crashed before it evaluated its end edges, so a replay must not
      // fall through to them (round 4 review). A human/generate successor whose row is
      // waiting re-asserts the run's waiting status, idempotently — the original
      // pass may have crashed before its patchRun (round 4 review).
      if ((target.type === "human" || target.type === "generate") && getRun(ctx, runId)?.status === "running") {
        await patchRun(ctx, runId, { status: "waiting" });
      }
      started = true; // handled or fired, a started successor owns the continuation
      continue;
    }
    if (outcome.kind === "terminal") return; // the run was stopped while the edge fired: nothing to start
    if (outcome.kind === "loop-limit") {
      await failRun(ctx, runId, `loop limit ${edge.from}->${edge.to}`, outcome.loops, e.deps);
      markAdvanced();
      return;
    }
    if (outcome.loops) await publishRunChange(ctx, getRun(ctx, runId)); // the loop counters changed
    started = true; // a started step owns the run's continuation from here
    const fresh = getRun(ctx, runId)!;
    if (isTerminal(fresh)) return;
    try {
      if (target.type === "human") {
        const humanRow = outcome.rows[0];
        if (humanRow) startHumanWaiting(ctx, fresh, humanRow.stepId, humanRow.attempt, target, humanRow.branch);
        if (!isTerminal(getRun(ctx, runId))) await patchRun(ctx, runId, { status: "waiting" });
        continue;
      }
      if (target.type === "generate") {
        for (const row of outcome.rows) {
          await startGenerateStep(ctx, fresh, row.stepId, target, row.attempt);
        }
        continue;
      }
      // A non-waiting successor puts the run back to running: a swallowed run.answer
      // conflict (the answer was recorded, its waiting→running patch lost) must not
      // leave the run waiting while a task of the run is in flight (round 5 review).
      if (fresh.status === "waiting") {
        try { await patchRun(ctx, runId, { status: "running" }); }
        catch (err) {
          if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
        }
      }
      for (const row of outcome.rows) {
        if (target.type === "fanout") await delegateFanoutBranch(ctx, fresh, row, target, e);
        else if (target.type === "agent" && target.role === "orchestrator") {
          // fireEdge already inserted the running row; finish it as an orchestrator turn.
          await startOrchestratorRoleStep(ctx, fresh, def, row.stepId, target, row.attempt, {
            settleLiveOrchTurn: e.settleLiveOrchTurn,
          });
        } else if (target.type === "agent") await delegateAgentRow(ctx, fresh, row, target, e);
        else if (target.type === "choose_workflow") {
          await startChooseWorkflowStep(ctx, fresh, row.stepId, target, row.attempt);
        } else throw new CoreError("not_allowed", `step type '${target.type}' is not started as a task here`);
      }
    } catch (err) {
      // An admission race that outlived its retries: the successor row has no task,
      // so the tick delegates it again.
      if (isAdmissionRace(err)) continue;
      // A start failure ends the run (no eligible executor, validation, …): it
      // must never escape advanceFrom, where it would stall the change cursor
      // and block every other run's settlement (Review Focus 3).
      await failRun(ctx, runId, `start failed: ${edge.to}: ${err instanceof Error ? err.message : String(err)}`, undefined, e.deps);
      markAdvanced();
      return;
    }
  }
  if (ends.length > 0 && !started) {
    const current = getRun(ctx, runId);
    if (isTerminal(current)) return;
    // An end edge does not finish a run while other step rows of the run are still
    // running or waiting — every row of the run, not only the successors started in
    // this call: their settlements own the run's ending (Review Focus: run
    // correctness 5). A fan-out attempt's branch rows are covered by its
    // branch-less join row only once the fan-out resolved; before that the attempt
    // is unresolved and its branches count as busy, so an end edge never finishes
    // the run while one of its fan-outs is still in flight (Review Focus: run
    // correctness 9). The deferred end is retried by this step's own re-advance or
    // the finishing step's settlement.
    const rows = stepsOfRun(ctx, runId);
    const busy = rows.some(s => {
      const same = s.runId === settled.runId && s.stepId === settled.stepId && s.attempt === settled.attempt
        && (s.branch ?? undefined) === (settled.branch ?? undefined);
      if (same) return false; // the row currently being advanced: its own end is being decided here
      if (s.status === "running" || s.status === "waiting" || (isHeldBranch(s) && s.advancedAt === undefined)) {
        if (s.branch === undefined) return true;
        return !fanoutJoined(rows, s);
      }
      // A done row whose advancement never landed (advanced_at unset) may still
      // fire its successors — or fail the run — so the end waits until its own
      // advancement recorded advanced_at (round 4 review). Branch rows are covered
      // by their attempt's join row, as above. A branch-less row that would fire
      // only end edges no longer holds work back: counting it busy forever would
      // let two rows defer on each other and stall the run, so the end applies —
      // the row's own end decision reaches the same outcome.
      if (s.status !== "done" || s.advancedAt !== undefined) return false;
      if (s.branch !== undefined) return !fanoutJoined(rows, s);
      const sibling = matchedEdges(def, run!, s.stepId, s.result);
      return sibling.length === 0 || sibling.some(({ edge }) => {
        const to = def.steps[edge.to];
        return !to || to.type !== "end";
      });
    });
    if (busy) return;
    await patchRun(ctx, runId, { status: "done" });
  }
  markAdvanced();
}

/** Re-advances a done step row whose outgoing edges may never have been processed
 *  (advanced_at unset: a crash between marking the step done and advancing, or an
 *  answer whose run patch conflicted). Only live runs, and never fan-out branch rows,
 *  whose branch-less join row owns the advancement. */
export async function readvanceStep(ctx: Ctx, row: StepRow, spawn?: SpawnRunner, deps: EngineDeps = defaultEngineDeps): Promise<boolean> {
  if (row.status !== "done" || row.advancedAt !== undefined) return false;
  if (row.branch !== undefined) return false;
  const run = getRun(ctx, row.runId);
  if (!run || isTerminal(run)) return false;
  const def = loadDefinition(ctx, run);
  if (!def || !def.steps[row.stepId]) return false;
  await advanceFrom(ctx, run.id, def, row, row.result, { deps, spawn });
  return true;
}

/** The open failed instances of a step: failures not superseded by a later attempt
 *  of the same step+branch (N5), earliest first (startedAt, then branch name). */
function openFailedSteps(ctx: Ctx, runId: string, stepId: string): StepRow[] {
  const steps = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId);
  return steps.filter(s => s.status === "failed")
    .filter(f => !steps.some(s =>
      (f.branch === undefined ? s.branch === undefined : s.branch === f.branch)
      && s.attempt > f.attempt,
    ))
    .sort((a, b) => a.startedAt !== b.startedAt
      ? a.startedAt - b.startedAt
      : (a.branch ?? "").localeCompare(b.branch ?? ""));
}

/** The earliest open failure — one branch at a time (G5). */
function latestFailedStep(ctx: Ctx, runId: string, stepId: string): StepRow | null {
  return openFailedSteps(ctx, runId, stepId)[0] ?? null;
}

function clearStepFailureWakeups(ctx: Ctx, row: StepRow): void {
  const ref = stepWakeRef(row.runId, row.stepId, row.attempt, row.branch);
  completeWakeupRef(ctx, row.runId, "step_failed", ref);
  completeWakeupRef(ctx, row.runId, "step_invalid", ref);
}

/** The person's compare-and-set (P2): taken in the same tick as the change it guards. */
function claimRunRev(ctx: Ctx, run: RunRow, expectRev: number | undefined): void {
  if (expectRev !== undefined) updateRun(ctx, run.id, expectRev, {});
}

/** Skip a failed step (treat as done with `{ skipped: true }`) and advance. The person
 *  passes the run's rev; a run grant does not. */
export async function skipFailedStep(
  ctx: Ctx,
  input: { runId: string; stepId: string; expectRev?: number },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  const row = latestFailedStep(ctx, input.runId, input.stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} of ${input.runId} is not failed`);
  const def = loadDefinition(ctx, run);
  if (!def) throw new CoreError("not_found", `missing definition for run ${input.runId}`);
  const stepDef = def.steps[input.stepId];
  const joined = fanoutJoined(stepsOfRun(ctx, run.id), row);
  // A rejected branch its join no longer needed owes nothing.
  if (stepDef?.type === "fanout" && joined && isHeldBranch(row)) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} already joined`);
  }
  claimRunRev(ctx, run, input.expectRev);
  const result = { skipped: true };
  const done = updateStep(ctx, keyOf(row), { status: "done", result, endedAt: ctx.now });
  clearStepFailureWakeups(ctx, row);
  pruneAbandonedConflicts(ctx, run.id);
  try {
    if (!isTerminal(getRun(ctx, run.id)) && getRun(ctx, run.id)?.status === "waiting") {
      await patchRun(ctx, run.id, { status: "running" });
    }
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  // Skipping a branch the review rejected lets its waiting join finish.
  if (stepDef?.type === "fanout" && !joined && isHeldBranch(row)) {
    await joinFanout(ctx, getRun(ctx, run.id)!, def, done, stepDef, withDefaults({ deps, spawn }));
  } else {
    await advanceFrom(ctx, run.id, def, done, result, { deps, spawn });
  }
  return getRun(ctx, run.id)!;
}

/** Retry a failed step by starting a new attempt. The person passes the run's rev;
 *  a run grant does not. */
export async function retryFailedStep(
  ctx: Ctx,
  input: { runId: string; stepId: string; expectRev?: number },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  const open = openFailedSteps(ctx, input.runId, input.stepId);
  if (open.length === 0) throw new CoreError("conflict", `conflict: step ${input.stepId} of ${input.runId} is not failed`);
  // Cap retries per step and branch — count prior retried failures (advancedAt),
  // not loop attempt numbers (S N5). A branch at its cap does not block the others.
  const rows = stepsOfRun(ctx, input.runId);
  const row = open.find(failed => !stepRetriesSpent(rows, failed));
  if (!row) {
    throw new CoreError("not_allowed", `step ${input.stepId} has reached the retry limit (${MAX_STEP_RETRIES})`);
  }
  const def = loadDefinition(ctx, run);
  const stepDef = def?.steps[input.stepId];
  if (!def || !stepDef) throw new CoreError("not_found", `unknown step ${input.stepId}`);
  // A paused run starts nothing: refuse before the failed attempt is touched.
  if (isRunStepPaused(run)) throw new CoreError("not_allowed", `run ${run.id} is paused (${run.pausedReason})`);
  const joined = row.branch !== undefined && fanoutJoined(stepsOfRun(ctx, input.runId), row);
  if (joined && isHeldBranch(row)) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} already joined`);
  }
  const branchOnly = stepDef.type === "fanout" && !joined && isHeldBranch(row);
  claimRunRev(ctx, run, input.expectRev);
  // Mark the failed attempt advanced so the tick does not keep recreating its wake-up.
  try { updateStep(ctx, keyOf(row), { advancedAt: ctx.now }); } catch { /* */ }
  clearStepFailureWakeups(ctx, row);
  try {
    if (!isTerminal(getRun(ctx, run.id)) && getRun(ctx, run.id)?.status === "waiting") {
      await patchRun(ctx, run.id, { status: "running" });
    }
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  if (branchOnly) {
    // Only this branch starts again; the rest of the fan-out stays as it is.
    const live = getRun(ctx, run.id)!;
    const retried = insertBranchRetry(ctx, { ...row, branch: row.branch! }, nextAttempt(ctx, run.id, input.stepId));
    await delegateFanoutBranch(ctx, live, retried, stepDef as FanoutStep, withDefaults({ deps, spawn }));
  } else {
    await startStep(ctx, getRun(ctx, run.id)!, def, input.stepId, row.branch, { deps, spawn });
  }
  // The failed attempt's conflicts went with it.
  pruneAbandonedConflicts(ctx, run.id);
  return getRun(ctx, run.id)!;
}

function yesNoSpelling(answer: string): string {
  const word = answer.trim().toLowerCase();
  return word === "yes" || word === "no" ? word : answer;
}

/** Answers a waiting human step: the answer becomes the step's result
 *  (`{ answer }` or `{ answer, note }`) and the run advances from it. */
export async function answerHumanStep(
  ctx: Ctx,
  runId: string,
  stepId: string,
  given: string,
  expectRev: number,
  deps: EngineDeps = defaultEngineDeps,
  spawn?: SpawnRunner,
  note?: string,
): Promise<RunRow> {
  if (typeof given !== "string" || given.length < 1) throw new CoreError("invalid_input", "answer must be a non-empty string");
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${runId} is ${run.status}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  const waiting = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) throw new CoreError("conflict", `conflict: step ${stepId} of ${runId} is not waiting for an answer`);
  const def = loadDefinition(ctx, run);
  const answered = def?.steps[stepId];
  if (!def || answered?.type !== "human") throw new CoreError("conflict", `conflict: step ${stepId} is not a human step`);
  // Edge conditions and the publish gate compare the engine's spelling; buttons and
  // people may send "Yes".
  const answer = answered.question.kind === "yes_no" ? yesNoSpelling(given) : given;
  // Defence: a run-grant caller may only answer auto-effective steps (run.decide path).
  // must / strict / auto-off steps stay person-only via run.answer.
  // Escalated (or sync-flipped) human_step questions stay person-owned even when canAutoDecide (I-2).
  if (ctx.env.PACER_RUN_GRANT) {
    const stepDef = def.steps[stepId];
    // Auto flag lives on the root (choose_workflow children inherit it) — I2.
    const root = getRun(ctx, rootRunId(ctx, runId)) ?? run;
    if (!stepDef || stepDef.type !== "human" || !canAutoDecide(root, stepId, stepDef)) {
      throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
    }
    // Escalated human_step questions stay person-owned even when canAutoDecide (I-2).
    // chain includes "orchestrator" after escalate; plain person + !canAutoDecide is must/strict/auto-off.
    const openQs = listQuestions(ctx, runId, "open").filter(q =>
      q.askerKind === "human_step"
      && q.stepId === stepId
      && q.attempt === row.attempt
      && (q.branch ?? undefined) === (row.branch ?? undefined)
      && q.answerer === "person",
    );
    if (openQs.some(q => q.chain.includes("orchestrator"))) {
      throw new CoreError("not_allowed", "Only the person can answer this question");
    }
  }
  // Publishing gate (D5/R2-F6): tip is read BEFORE the claim; grant callers refused
  // before burning the step; decision is written inside claimStepAnswer's transaction.
  const humanDef = def.steps[stepId];
  // A generated graph's `approves` means nothing: graphs stored before the
  // validator refused it answer like any other human step.
  const isPublishApproval = humanDef?.type === "human"
    && humanDef.approves === "publish"
    && !isGeneratedRun(ctx, run)
    && (answer === "approve" || answer === "yes");
  let publishDecision: {
    runId: string; stepId: string; attempt: number; actor: string;
    kind: string; choice: string; reason: string;
  } | undefined;
  if (isPublishApproval) {
    if (ctx.env.PACER_RUN_GRANT) {
      throw new CoreError("not_allowed", "publish approval requires a person");
    }
    await adoptGeneratedBranches(ctx, run);
    const branch = branchOwner(ctx, run).branch;
    if (!branch) {
      throw new CoreError("unavailable", "cannot read branch tip for publish approval");
    }
    const tipResult = await ctx.run(
      ["git", "-C", run.repo, "rev-parse", "--verify", `refs/heads/${branch}`],
      10_000,
    );
    const tip = tipResult.stdout.trim();
    if (tipResult.code !== 0 || !/^[0-9a-f]{40,64}$/i.test(tip)) {
      throw new CoreError("unavailable", "cannot read branch tip for publish approval");
    }
    publishDecision = {
      // The decision lives with the branch it approves, where run.publish reads it.
      runId: branchOwner(ctx, run).id,
      stepId,
      attempt: row.attempt,
      actor: "person",
      kind: "publish_approved",
      choice: answer,
      reason: `approves: publish tip=${tip.toLowerCase()}`,
    };
  }
  const cleanedNote = note !== undefined && note.trim() !== "" ? sanitizeAnswerNote(note) : undefined;
  const stepResult = cleanedNote !== undefined && cleanedNote.trim() !== ""
    ? { answer, note: cleanedNote }
    : { answer };
  // One yield before the claim: a concurrent answer (or a stopping run) can then
  // reach the same row, and it is claimStepAnswer below — not the luck of
  // synchronous execution — that makes the answer exclusive (round 4 review).
  await Promise.resolve();
  // Compare-and-set like claimStepSettlement: a second answer to the same waiting
  // step loses the race and is a conflict — it starts nothing.
  const claimed = claimStepAnswer(
    ctx,
    keyOf(row),
    stepResult,
    publishDecision ? { decision: publishDecision } : undefined,
  );
  if (!claimed) throw new CoreError("conflict", `conflict: step ${stepId} of ${runId} is not waiting for an answer`);
  // Resolve the structured question this human step raised (Phase 4); ignore if
  // already answered (question.answer may have raced with run.answer).
  try {
    resolveHumanStepQuestion(
      ctx,
      runId,
      stepId,
      row.attempt,
      answer,
      ctx.env.PACER_RUN_GRANT ? "orchestrator" : "person",
      row.branch,
      cleanedNote !== undefined && cleanedNote !== "" ? cleanedNote : undefined,
    );
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  // The answer is recorded: a conflicting run patch (the run went terminal, or a
  // concurrent writer moved its rev) must not fail the answer — it took effect and
  // advances below, or via the tick's re-advance when this advance is lost
  // (round 4 review).
  try {
    if (!isTerminal(getRun(ctx, runId))) await patchRun(ctx, runId, { status: "running" });
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  await advanceFrom(ctx, runId, def, claimed, stepResult, { deps, spawn });
  return getRun(ctx, runId)!;
}

/** Start a child run from an approved (or auto-approved) graph version. */
export async function startGeneratedChild(
  ctx: Ctx,
  input: { runId: string; stepId: string; version: number; onClaim?: () => void },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  const def = loadDefinition(ctx, run);
  const stepDef = def?.steps[input.stepId];
  if (!stepDef || stepDef.type !== "generate") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not a generate step`);
  }
  // Validate version + claim choosing + mark approved in one immediate transaction
  // so a crash cannot leave choosing:true against a missing/invalid version (I4 / M2).
  const { latest, prior } = workflowDatabase(ctx).transaction(() => {
    const waiting = stepsOfRun(ctx, run.id).filter(s => s.stepId === input.stepId && s.status === "waiting");
    const row = waiting[waiting.length - 1];
    if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a graph`);
    const priorChild = chooseStepChildRunId(row.result);
    if (priorChild) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} already has child ${priorChild}`);
    }
    const prev = row.result != null && typeof row.result === "object"
      ? { ...(row.result as Record<string, unknown>) }
      : {};
    if (prev.choosing === true) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} is already starting a child`);
    }
    const graph = workflowDatabase(ctx).query<{ status: string }, [string, string, number, number]>(
      "SELECT status FROM workflow_graphs WHERE run_id = ? AND step_id = ? AND attempt = ? AND version = ?",
    ).get(run.id, input.stepId, row.attempt, input.version);
    if (!graph) throw new CoreError("not_found", `unknown graph version ${input.version}`);
    if (graph.status !== "proposed" && graph.status !== "approved") {
      throw new CoreError("conflict", `conflict: graph version ${input.version} is ${graph.status}`);
    }
    // Compare-and-set: approval must still point at this version.
    if (typeof prev.graphVersion === "number" && prev.graphVersion !== input.version) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} graph version changed`);
    }
    updateStep(ctx, keyOf(row), {
      result: { ...prev, graphVersion: input.version, choosing: true, choosingAt: ctx.now, pendingApproval: undefined },
    });
    setGraphStatus(ctx, {
      runId: run.id, stepId: input.stepId, attempt: row.attempt, version: input.version,
    }, "approved");
    input.onClaim?.();
    return { latest: row, prior: prev };
  }).immediate();

  let childDef: WorkflowDef;
  try {
    childDef = installGeneratedDefinition(ctx, run, input.stepId, input.version);
  } catch (err) {
    try {
      const fresh = stepsOfRun(ctx, latest.runId).find(s =>
        s.stepId === latest.stepId && s.attempt === latest.attempt
        && (latest.branch !== undefined ? s.branch === latest.branch : !s.branch),
      );
      const choosing = fresh?.result != null && typeof fresh.result === "object"
        && (fresh.result as { choosing?: unknown }).choosing === true;
      if (fresh?.status === "waiting" && choosing) {
        const restoreApproval = !!(stepDef.approval || prior.replanMode === "ask");
        updateStep(ctx, keyOf(latest), {
          result: {
            ...prior,
            graphVersion: input.version,
            pendingApproval: restoreApproval ? true : undefined,
            choosing: undefined,
            choosingAt: undefined,
          },
        });
        if (restoreApproval) {
          setGraphStatus(ctx, {
            runId: run.id, stepId: input.stepId, attempt: latest.attempt, version: input.version,
          }, "proposed");
        }
      }
    } catch { /* */ }
    throw err;
  }

  const rootId = rootRunId(ctx, run.id);
  const root = getRun(ctx, rootId)!;
  // Replan: seed finished steps from the prior child so they are not re-delegated (I-4).
  const finishedIds = Array.isArray(prior.replanFinished)
    ? (prior.replanFinished as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const fromChildId = typeof prior.replanFromChildId === "string" ? prior.replanFromChildId : undefined;
  let seedFinished: SeedFinished | undefined;
  if (finishedIds.length > 0 && fromChildId) {
    const results: Record<string, unknown> = {};
    for (const s of stepsOfRun(ctx, fromChildId)) {
      if (s.branch !== undefined) continue;
      if (!finishedIds.includes(s.stepId)) continue;
      if (s.status !== "done") continue;
      if (s.result !== undefined) results[s.stepId] = s.result;
    }
    seedFinished = { finishedIds, results };
  }
  let child: RunRow;
  try {
    if (!await adoptGeneratedBranches(ctx, getRun(ctx, run.id)!)) {
      throw new CoreError("unavailable", "merge the previous generated run's branch into the run branch first");
    }
    child = await startRun(ctx, {
      workflow: childDef.id,
      repo: run.repo,
      brief: run.brief,
      title: `${run.title} · ${childDef.id}`,
    }, spawn, deps, {
      parentRunId: run.id,
      parentStep: input.stepId,
      planner: root.planner,
      orchestratorTaskId: root.orchestratorTaskId,
      sessionId: root.sessionId,
      skipLiveGate: true,
      ...(seedFinished ? { seedFinished } : {}),
    });
  } catch (err) {
    try {
      const fresh = stepsOfRun(ctx, latest.runId).find(s =>
        s.stepId === latest.stepId && s.attempt === latest.attempt
        && (latest.branch !== undefined ? s.branch === latest.branch : !s.branch),
      );
      const choosing = fresh?.result != null && typeof fresh.result === "object"
        && (fresh.result as { choosing?: unknown }).choosing === true;
      if (fresh?.status === "waiting" && choosing) {
        const restoreApproval = !!(stepDef.approval || prior.replanMode === "ask");
        updateStep(ctx, keyOf(latest), {
          result: {
            ...prior,
            graphVersion: input.version,
            pendingApproval: restoreApproval ? true : undefined,
            choosing: undefined,
            choosingAt: undefined,
          },
        });
        if (restoreApproval) {
          setGraphStatus(ctx, {
            runId: run.id, stepId: input.stepId, attempt: latest.attempt, version: input.version,
          }, "proposed");
        }
      }
    } catch { /* */ }
    throw err;
  }
  // Parent may already be advanced when the child finished inside startRun.
  const stillWaiting = stepsOfRun(ctx, latest.runId).find(s =>
    s.stepId === latest.stepId && s.attempt === latest.attempt
    && (latest.branch !== undefined ? s.branch === latest.branch : !s.branch)
    && s.status === "waiting",
  );
  if (stillWaiting) {
    updateStep(ctx, keyOf(latest), {
      result: {
        ...prior,
        graphVersion: input.version,
        childRunId: child.id,
        pendingApproval: undefined,
        choosing: undefined,
        choosingAt: undefined,
        replanMode: undefined,
      },
    });
  }
  completeWakeupRef(ctx, run.id, "orchestrator_step", stepWakeRef(run.id, input.stepId, latest.attempt));
  completeWakeupRef(ctx, run.id, "question", stepWakeRef(run.id, input.stepId, latest.attempt));
  completeWakeupRef(ctx, run.id, "replan", stepWakeRef(run.id, input.stepId, latest.attempt));
  return child;
}

/** Approve or revise a proposed generated graph (Phase 2 human-step machinery). */
export async function answerGenerateApproval(
  ctx: Ctx,
  input: {
    runId: string;
    stepId: string;
    answer: "approve" | "revise" | string;
    note?: string;
    expectRev: number;
  },
  deps: EngineDeps = defaultEngineDeps,
  spawn?: SpawnRunner,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  if (run.rev !== input.expectRev) {
    throw new CoreError("conflict", `conflict: run ${input.runId} changed since rev ${input.expectRev}`);
  }
  const def = loadDefinition(ctx, run);
  const stepDef = def?.steps[input.stepId];
  if (!stepDef || stepDef.type !== "generate") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not a generate step`);
  }
  const waiting = stepsOfRun(ctx, input.runId).filter(s => s.stepId === input.stepId && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} of ${input.runId} is not waiting`);
  const prior = row.result != null && typeof row.result === "object"
    ? { ...(row.result as Record<string, unknown>) }
    : {};
  if (prior.pendingApproval !== true || typeof prior.graphVersion !== "number") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for approval`);
  }
  // Pending approval may come from generate.approval or from replan ask.
  if (!stepDef.approval && prior.replanMode !== "ask") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} does not require approval`);
  }
  const root = getRun(ctx, rootRunId(ctx, input.runId)) ?? run;
  if (ctx.env.PACER_RUN_GRANT) {
    // An escalated approval stays the person's, like an escalated human step.
    const escalated = listQuestions(ctx, input.runId, "open").some(q => q.askerKind === "human_step"
      && q.stepId === input.stepId && q.attempt === row.attempt
      && q.answerer === "person" && q.chain.includes("orchestrator"));
    if (escalated) throw new CoreError("not_allowed", "Only the person can answer this question");
    if (!orchestratorMayApprove(root, input.stepId, stepDef, prior)) {
      throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
    }
  }
  const answeredBy = ctx.env.PACER_RUN_GRANT ? "orchestrator" : "person";
  const resolveApproval = (answer: string, note?: string) => {
    resolveHumanStepQuestion(ctx, run.id, input.stepId, row.attempt, answer, answeredBy, undefined, note);
  };
  const answer = input.answer.trim().toLowerCase();
  const isApprove = answer === "approve";
  // Exact "revise", or "revise:" / "revise " with a note — not prefixes like "reviser".
  const isRevise = answer === "revise" || answer.startsWith("revise:") || answer.startsWith("revise ");
  if (!isApprove && !isRevise) {
    throw new CoreError("invalid_input", "answer must be approve or revise");
  }
  if (isApprove) {
    await startGeneratedChild(ctx, {
      runId: input.runId,
      stepId: input.stepId,
      version: prior.graphVersion as number,
      // Resolved with the claim: a failed start restores the approval, and the tick asks again.
      onClaim: () => resolveApproval("approve"),
    }, spawn, deps);
    return getRun(ctx, input.runId)!;
  }
  const rawNote = input.note
    ?? (answer.startsWith("revise:") || answer.startsWith("revise ")
      ? answer.replace(/^revise[:\s]+/i, "").trim()
      : "");
  // Trim before emptiness so whitespace-only notes do not become fenced space blocks.
  const note = typeof rawNote === "string" && rawNote.trim() !== "" ? rawNote : undefined;
  const reviseCount = (typeof prior.reviseCount === "number" ? prior.reviseCount : 0) + 1;
  const retries = stepDef.retries ?? 2;
  setGraphStatus(ctx, {
    runId: run.id, stepId: input.stepId, attempt: row.attempt, version: prior.graphVersion as number,
  }, "rejected", note);
  resolveApproval("revise", note);
  if (reviseCount > retries) {
    updateStep(ctx, keyOf(row), {
      status: "failed",
      error: `generate revise failed after ${retries} retries`,
      endedAt: ctx.now,
      result: { ...prior, reviseCount, reviseNote: note, pendingApproval: undefined },
    });
    enqueueWakeup(ctx, {
      runId: run.id,
      cause: "step_failed",
      ref: stepWakeRef(run.id, input.stepId, row.attempt),
      createdAt: ctx.now,
    });
    return getRun(ctx, input.runId)!;
  }
  updateStep(ctx, keyOf(row), {
    result: {
      ...prior,
      reviseCount,
      reviseNote: note,
      pendingApproval: undefined,
      graphVersion: undefined,
    },
  });
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "orchestrator_step",
    ref: stepWakeRef(run.id, input.stepId, row.attempt),
    createdAt: ctx.now,
    byPerson: answeredBy === "person",
  });
  completeWakeupRef(ctx, run.id, "question", stepWakeRef(run.id, input.stepId, row.attempt));
  try {
    if (!isTerminal(getRun(ctx, input.runId)) && getRun(ctx, input.runId)?.status === "waiting") {
      await patchRun(ctx, input.runId, { status: "waiting" });
    }
  } catch { /* */ }
  return getRun(ctx, input.runId)!;
}

/** Settle the engine-owned root work node when its run ends. */
function settleRootWorkNode(ctx: Ctx, run: RunRow, status: "done" | "stopped" | "failed"): void {
  if (!run.rootTaskId) return;
  const task = readTask(ctx, run.rootTaskId);
  if (!task || SETTLE_STATES.includes(task.state)) return;
  try {
    updateTask(ctx, run.rootTaskId, t => {
      t.state = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done";
      t.result = {
        status: t.state as "done" | "stopped" | "failed",
        executor: null,
        model: null,
        files: "",
        report: `workflow root ${status}`,
        backend: "direct",
      };
    });
  } catch { /* */ }
}

/** Stop result: the run row plus optional `{ branch, ahead }` when a run branch exists. */
export type StoppedRun = RunRow & { ahead?: number };

/** Stops a run: every running or waiting step row is marked stopped, running step
 *  tasks are stopped through the task.stop op path, child runs are stopped, the
 *  root work node is settled, and the run itself is marked stopped. The run branch
 *  and merged work stay; the integration worktree is removed on terminal settle. */
export async function stopRun(ctx: Ctx, runId: string, expectRev: number, deps: EngineDeps = defaultEngineDeps): Promise<StoppedRun> {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${runId} is ${run.status}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  // Stop choose/generate children first so their settlement does not race the parent.
  const children = workflowDatabase(ctx).query<{ id: string; rev: number }, [string]>(
    "SELECT id, rev FROM workflow_runs WHERE parent_run_id = ? AND status IN ('running', 'waiting')",
  ).all(runId);
  for (const child of children) {
    try { await stopRun(ctx, child.id, child.rev, deps); } catch { /* */ }
  }
  for (const row of stepsOfRun(ctx, runId)) {
    if (row.status !== "running" && row.status !== "waiting") continue;
    stopStepTask(ctx, row, deps);
    try { updateStep(ctx, keyOf(row), { status: "stopped", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
  }
  pruneAbandonedConflicts(ctx, runId);
  const stopped = await patchRun(ctx, runId, { status: "stopped" }, { deps, spawn: undefined });
  settleRootWorkNode(ctx, stopped, "stopped");
  const report = await branchReportFor(ctx, stopped);
  return report.ahead === undefined ? { ...stopped, ...report } : { ...stopped, ahead: report.ahead };
}
