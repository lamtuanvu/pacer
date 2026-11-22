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
import { getWork, registerWork, setWorkDependencies } from "../dispatch/work";
import { createTask, readTask, updateTask } from "../tasks/store";
import type { TaskState } from "../tasks/types";
import { CoreError } from "../core/errors";
import { publish } from "../link/publish";
import { backEdgeIndexes } from "./validate";
import { evalCondition, parseCondition } from "./condition";
import { renderPrompt } from "./template";
import {
  attachStepTask, claimStepAnswer, claimStepSettlement, fireEdge, getDefinition, getRun, insertFanoutBranches, insertJoinStep, insertRun, insertStep, rootRunId, runEntityValue, setGraphStatus, stepByTask, stepsOfRun, taskByRequestId,
  updateRun, updateStep, workflowDatabase, type RunPatch, type RunRow, type StepKey, type StepRow,
} from "./store";
import { chooseStepChildRunId, completeWakeupRef, enqueueWakeup, stepWakeRef } from "./wakeups";
import { budgetForDefinition, serializeBudget, serializeSpent } from "./budget";
import { canAutoApproveGenerate, canAutoDecide } from "./auto";
import { stopLiveTurnsForRun } from "./orchestrator";
import { ensureRootWorkNode, isWorkNodeRun, predecessorTaskIds } from "./worknode";
import { installGeneratedDefinition } from "./generate";
import { isPlainObject, type AgentStep, type ChooseWorkflowStep, type FanoutStep, type GenerateStep, type HumanStep, type JsonSchemaLite, type WorkflowDef } from "./schema";
import { loadStrategy } from "../config/strategy";

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

/** Task states whose settlement a step instance follows. `partial` and `needs_input`
 *  stay out: Phase 1 has no orchestrator to hand them to (plan, settlement rules). */
const SETTLE_STATES: readonly TaskState[] = ["done", "failed", "stopped", "limit"];
const RUN_TERMINAL: readonly RunRow["status"][] = ["done", "failed", "stopped"];

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
}

interface EngineOptions {
  deps: EngineDeps;
  spawn?: SpawnRunner;
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
  const out: Record<string, { result?: unknown }> = {};
  for (const row of stepsOfRun(ctx, runId)) {
    if (row.result !== undefined) out[row.stepId] = { result: row.result };
  }
  return out;
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
  const updated = updateRun(ctx, runId, run.rev, patch);
  await publishRunChange(ctx, updated);
  // Only a root run terminal stops the shared orchestrator turn (round-2 I1).
  // A choose_workflow child ending must leave the root's live turn alone.
  if (patch.status && RUN_TERMINAL.includes(patch.status) && !updated.parentRunId) {
    stopLiveTurnsForRun(ctx, runId, `run ${patch.status}`);
  }
  if (patch.status && RUN_TERMINAL.includes(patch.status)) {
    settleRootWorkNode(ctx, updated, patch.status === "failed" ? "failed" : patch.status === "stopped" ? "stopped" : "done");
  }
  if (patch.status && RUN_TERMINAL.includes(patch.status) && updated.parentRunId && updated.parentStep) {
    await settleParentChooseStep(ctx, updated, o?.deps ?? defaultEngineDeps, o?.spawn);
  }
  return updated;
}

/** Fails a run with a reason (and optionally the loop counters that led there) and
 *  stops its in-flight step tasks; those rows are marked stopped too. Terminal runs
 *  stay terminal. */
export async function failRun(ctx: Ctx, runId: string, reason: string, loops?: Record<string, number>, deps: EngineDeps = defaultEngineDeps): Promise<void> {
  const current = getRun(ctx, runId);
  if (!current) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(current.status)) return;
  await patchRun(ctx, runId, { status: "failed", reason, ...(loops ? { loops } : {}) }, { deps, spawn: undefined });
  for (const row of stepsOfRun(ctx, runId)) {
    if (row.status !== "running") continue;
    if (row.taskId) {
      try { deps.stopTask(ctx, row.taskId); } catch { /* failing the run must not depend on one task */ }
    }
    try { updateStep(ctx, keyOf(row), { status: "stopped", error: "run failed", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
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
      wakeAutoHumanStep(ctx, run, stepId, attempt, stepDef);
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

/** A role:orchestrator step: no new task; links the shared orchestrator task and wakes a turn. */
async function startOrchestratorRoleStep(
  ctx: Ctx,
  run: RunRow,
  def: WorkflowDef,
  stepId: string,
  stepDef: AgentStep,
  attempt: number,
): Promise<StepRow> {
  const orchTaskId = ensureOrchestratorTask(ctx, getRun(ctx, run.id)!);
  // UNIQUE(task_id): clear any prior attempt's link so this attempt can own it.
  workflowDatabase(ctx).query("UPDATE workflow_steps SET task_id = NULL WHERE task_id = ?").run(orchTaskId);
  const prompt = renderPrompt(stepDef.prompt, {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    run: { id: run.id, stepId },
  });
  // Stash the rendered prompt for the next turn — do not queue or launch here;
  // only startTurn may queue the orchestrator task (D2.10).
  updateTask(ctx, orchTaskId, t => {
    t.brief = { goal: prompt, repo: run.repo };
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
/** After a plain delegate, attach the task under the run's root work node when pinned. */
function attachUnderRoot(ctx: Ctx, run: RunRow, taskId: string, stepId: string): void {
  if (!isWorkNodeRun(run)) return;
  const rootId = ensureRootWorkNode(ctx, getRun(ctx, run.id) ?? run);
  if (readTask(ctx, rootId)?.state !== "running") {
    try { updateTask(ctx, rootId, t => { t.state = "running"; }); } catch { /* */ }
  }
  if (!getWork(ctx, taskId)) {
    try { registerWork(ctx, taskId, {}, rootId); } catch { /* already registered or parent closed */ }
  }
  const def = loadDefinition(ctx, getRun(ctx, run.id) ?? run);
  if (!def || !getWork(ctx, taskId)) return;
  const deps = predecessorTaskIds(ctx, getRun(ctx, run.id) ?? run, stepId, def)
    .filter(id => id !== taskId && getWork(ctx, id));
  if (deps.length === 0) return;
  try {
    setWorkDependencies(ctx, taskId, deps, readTask(ctx, taskId)!.rev);
  } catch { /* race or cycle guard */ }
}

async function delegateAgentRow(ctx: Ctx, run: RunRow, row: StepRow, stepDef: AgentStep, e: EngineOptions): Promise<StepRow> {
  const prompt = renderPrompt(stepDef.prompt, {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    branch: row.branch,
    run: { id: run.id, stepId: row.stepId },
  });
  const key = keyOf(row);
  const requestId = stepRequestId(run.id, row.stepId, row.attempt, row.branch);
  const task = await e.deps.delegate(ctx, {
    brief: { goal: prompt, repo: run.repo },
    kind: stepDef.kind,
    ...(stepDef.difficulty ? { difficulty: stepDef.difficulty } : {}),
    title: stepTitle(run, row.stepId, row.branch),
    requestId,
  }, e.spawn);
  // Re-read after the await: the run may have gone terminal while the delegation was
  // pending; then the task is stopped and nothing else happens.
  if (isTerminal(getRun(ctx, run.id))) {
    try { e.deps.stopTask(ctx, task.id); } catch { /* stopping must not throw into the engine */ }
    try { updateStep(ctx, key, { status: "stopped", error: "run stopped while delegating", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
    return updateStep(ctx, key, {});
  }
  attachUnderRoot(ctx, getRun(ctx, run.id) ?? run, task.id, row.stepId);
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
    row = insertStep(ctx, { ...key, status: "running" });
  }
  return delegateAgentRow(ctx, getRun(ctx, run.id)!, row, stepDef, e);
}

/** Delegates the task for an already-inserted fan-out branch row (see
 *  delegateAgentRow for the insert-first-then-delegate rationale). */
async function delegateFanoutBranch(ctx: Ctx, run: RunRow, row: StepRow, stepDef: FanoutStep, e: EngineOptions): Promise<StepRow> {
  const branch = row.branch!;
  const prompt = renderPrompt(stepDef.each.prompt, {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    branch,
    run: { id: run.id, stepId: row.stepId },
  });
  const key = keyOf(row);
  const task = await e.deps.delegate(ctx, {
    brief: { goal: prompt, repo: run.repo },
    kind: stepDef.each.kind,
    ...(stepDef.each.difficulty ? { difficulty: stepDef.each.difficulty } : {}),
    title: stepTitle(run, row.stepId, branch),
    requestId: stepRequestId(run.id, row.stepId, row.attempt, branch),
  }, e.spawn);
  if (isTerminal(getRun(ctx, run.id))) {
    try { e.deps.stopTask(ctx, task.id); } catch { /* stopping must not throw into the engine */ }
    try { updateStep(ctx, key, { status: "stopped", error: "run stopped while delegating", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
    return updateStep(ctx, key, {});
  }
  attachUnderRoot(ctx, getRun(ctx, run.id) ?? run, task.id, row.stepId);
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

/** Starts a run: creates the run record and starts its entry step. A failing start
 *  fails the run (never leaves it silently stuck) and rethrows. */
export async function startRun(
  ctx: Ctx,
  input: { workflow: string; repo: string; brief: string; title?: string },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
  child?: { parentRunId: string; parentStep: string; planner?: string; orchestratorTaskId?: string; sessionId?: string },
): Promise<RunRow> {
  const def = getDefinition(ctx, input.workflow);
  if (!def) throw new CoreError("not_found", `unknown workflow '${input.workflow}'`);
  if (typeof input.brief !== "string" || !input.brief.trim()) throw new CoreError("invalid_input", "brief is required");
  if (typeof input.repo !== "string" || !input.repo) throw new CoreError("invalid_input", "repo is required");
  const budget = child ? undefined : budgetForDefinition(def);
  const run = insertRun(ctx, {
    workflow: def.id,
    version: def.version,
    repo: input.repo,
    brief: input.brief,
    title: input.title,
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
    } : {}),
  });
  await publishRunChange(ctx, run); // clients see the run even when its start then fails
  try {
    const live = getRun(ctx, run.id)!;
    if (isWorkNodeRun(live)) ensureRootWorkNode(ctx, live);
    if (def.steps[def.entry]?.type === "end") await patchRun(ctx, run.id, { status: "done" });
    else await startStep(ctx, getRun(ctx, run.id)!, def, def.entry, undefined, { deps, spawn });
  } catch (e) {
    await failRun(ctx, run.id, `start failed: ${e instanceof Error ? e.message : String(e)}`, undefined, deps);
    throw e;
  }
  const finished = getRun(ctx, run.id) ?? run;
  if (RUN_TERMINAL.includes(finished.status) && finished.parentRunId && finished.parentStep) {
    await settleParentChooseStep(ctx, finished, deps, spawn);
  }
  return finished;
}

/** When a child run of choose_workflow ends, finish the parent step with the child's result. */
async function settleParentChooseStep(
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
  const waiting = stepsOfRun(ctx, parent.id).filter(s => s.stepId === child.parentStep && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) return;
  const result = {
    workflow: child.workflow,
    reason: (row.result as { reason?: string } | undefined)?.reason ?? "",
    child: { id: child.id, status: child.status, reason: child.reason },
  };
  if (child.status !== "done") {
    // Mark the choose step failed and wake the root orchestrator.
    const failed = updateStep(ctx, keyOf(row), {
      status: "failed",
      error: child.reason ?? child.status,
      endedAt: ctx.now,
      result,
    });
    enqueueWakeup(ctx, {
      runId: parent.id,
      cause: "step_failed",
      ref: stepWakeRef(failed.runId, failed.stepId, failed.attempt, failed.branch),
      createdAt: ctx.now,
    });
    return;
  }
  const claimed = claimStepAnswer(ctx, keyOf(row), result);
  if (!claimed) return;
  await advanceFrom(ctx, parent.id, def, claimed, result, { deps, spawn });
}

function resultErrors(result: unknown, schema: JsonSchemaLite | undefined): string[] {
  if (!isPlainObject(result)) return ["result must be a JSON object"];
  return (schema?.required ?? []).filter(key => !Object.hasOwn(result, key)).map(key => `missing required key '${key}'`);
}

/** Records an agent step's structured result before settlement. Validated at once
 *  against the step's declared schema so the agent can fix it in the same turn
 *  (spec, "Returning a step result"). Serialized results are capped at 64 KiB so
 *  every transport stays inside its body limits. */
export function recordStepResult(ctx: Ctx, taskId: string, result: unknown): StepRow {
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} is not a workflow step`);
  if (step.status !== "running") throw new CoreError("conflict", `conflict: step ${step.stepId} is not running`);
  if (step.result !== undefined) throw new CoreError("conflict", `conflict: step ${step.stepId} already has a result`);
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
  const errors = resultErrors(result, schema);
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
  if (!task || !SETTLE_STATES.includes(task.state)) return;
  if (step.status !== "running") return;
  const def = loadDefinition(ctx, run);
  if (!def) return;
  // One yield before the claim: a concurrent settlement (the request thread's
  // attach path and the tick, say) can then read the row as still running too, and
  // it is the claim below — not the luck of synchronous execution — that makes the
  // settlement exclusive and the run advanced exactly once (Review Focus 6).
  await Promise.resolve();
  const done = task.state === "done" && step.result !== undefined;
  const error = done ? undefined : task.state === "done" ? "no step result" : task.state;
  const claimed = claimStepSettlement(ctx, keyOf(step), done ? { status: "done", endedAt: ctx.now } : { status: "failed", error, endedAt: ctx.now });
  if (!claimed) return; // another caller settled this step: the run advances exactly once
  const row = claimed;
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run); // every settlement publishes the run
  if (isTerminal(getRun(ctx, run.id))) return; // A terminal run only records the bookkeeping.
  const stepDef = def.steps[step.stepId];
  if (stepDef?.type === "fanout") {
    await joinFanout(ctx, run, def, step, stepDef, { deps, spawn });
    return;
  }
  if (row.status === "failed") {
    // Generated child: replan policy may take the failure instead of a plain step_failed wake.
    if (run.parentRunId && run.parentStep) {
      const { noteChildStepFailureForReplan } = await import("./replan");
      const noted = noteChildStepFailureForReplan(ctx, run.id, step.stepId);
      if (noted) return;
    }
    // Decision point: wake the orchestrator instead of ending the run (Phase 2).
    // Mechanical failures (no edge, loop limit, start failure) still use failRun.
    // Child runs share the root orchestrator: wake-ups are always keyed by root.
    const cause = error === "no step result" ? "step_invalid" as const : "step_failed" as const;
    enqueueWakeup(ctx, {
      runId: run.id,
      cause,
      ref: stepWakeRef(step.runId, step.stepId, step.attempt, step.branch),
      createdAt: ctx.now,
    });
    if (!isTerminal(getRun(ctx, run.id)) && getRun(ctx, run.id)?.status === "running") {
      try { await patchRun(ctx, run.id, { status: "waiting" }); }
      catch { /* concurrent terminal/waiting is fine */ }
    }
    return;
  }
  await advanceFrom(ctx, run.id, def, row, row.result, { deps, spawn });
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
  const rows = stepsOfRun(ctx, run.id).filter(s => s.stepId === settled.stepId && s.attempt === settled.attempt);
  const join = rows.find(s => s.branch === undefined);
  if (join && (join.status === "done" || join.status === "failed")) return;
  const byBranch = new Map(rows.filter(s => s.branch !== undefined).map(s => [s.branch!, s]));
  const done: StepRow[] = [];
  const failed: StepRow[] = [];
  const running: StepRow[] = [];
  const branchless: string[] = []; // definition branches whose row does not exist yet: still starting
  for (const branch of stepDef.branches) {
    const row = byBranch.get(branch);
    if (!row) { branchless.push(branch); continue; }
    if (row.status === "done") done.push(row);
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
      if (!b.taskId) continue;
      try { e.deps.stopTask(ctx, b.taskId); } catch { /* the join must not depend on one stop */ }
    }
  }
  const result = {
    branches: Object.fromEntries(stepDef.branches.map(b => [b, byBranch.get(b)?.result ?? null])),
    done: done.length,
    failed: failed.length,
  };
  // One yield before the join row: a concurrent join of the same attempt (the
  // change loop racing the tick's recovery, say) computes the same outcome, and the
  // INSERT OR IGNORE below — not the luck of synchronous execution — decides which
  // caller advances the run (round 4 review).
  await Promise.resolve();
  const joinRow = insertJoinStep(ctx, run.id, settled.stepId, settled.attempt, outcome, result);
  if (!joinRow) return; // the concurrent join inserted the row and owns the advancement
  await publishRunChange(ctx, getRun(ctx, run.id) ?? run); // the join publishes the run
  if (outcome === "failed") {
    await failRun(ctx, run.id, `step ${settled.stepId} ${failed[0]?.error ?? "failed"}`, undefined, e.deps);
    return;
  }
  await advanceFrom(ctx, run.id, def, joinRow, result, e);
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
    const outcome = fireEdge(ctx, {
      runId,
      from: { stepId: settled.stepId, attempt: settled.attempt, branch: settled.branch },
      edgeIndex: index,
      stepId: edge.to,
      status: target.type === "human" ? "waiting" : "running",
      ...(target.type === "fanout" ? { branches: target.branches } : {}),
      ...(back.has(index) ? { back: { key: `${edge.from}->${edge.to}`, maxLoops: edge.maxLoops ?? 0 } } : {}),
    });
    if (outcome.kind === "handled") {
      // An already-fired edge still owns the run's continuation: the original pass
      // may have crashed before it evaluated its end edges, so a replay must not
      // fall through to them (round 4 review). A human successor whose row is
      // waiting re-asserts the run's waiting status, idempotently — the original
      // pass may have crashed before its patchRun (round 4 review).
      if (target.type === "human" && getRun(ctx, runId)?.status === "running") {
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
        if (humanRow) wakeAutoHumanStep(ctx, fresh, humanRow.stepId, humanRow.attempt, target);
        if (!isTerminal(getRun(ctx, runId))) await patchRun(ctx, runId, { status: "waiting" });
        continue;
      }
      // A non-human successor puts the run back to running: a swallowed run.answer
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
          await startOrchestratorRoleStep(ctx, fresh, def, row.stepId, target, row.attempt);
        } else if (target.type === "agent") await delegateAgentRow(ctx, fresh, row, target, e);
        else if (target.type === "choose_workflow") {
          await startChooseWorkflowStep(ctx, fresh, row.stepId, target, row.attempt);
        } else throw new CoreError("not_allowed", `step type '${target.type}' is not started as a task here`);
      }
    } catch (err) {
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
      if (s.status === "running" || s.status === "waiting") {
        if (s.branch === undefined) return true;
        return !rows.some(j => j.branch === undefined && j.stepId === s.stepId && j.attempt === s.attempt);
      }
      // A done row whose advancement never landed (advanced_at unset) may still
      // fire its successors — or fail the run — so the end waits until its own
      // advancement recorded advanced_at (round 4 review). Branch rows are covered
      // by their attempt's join row, as above. A branch-less row that would fire
      // only end edges no longer holds work back: counting it busy forever would
      // let two rows defer on each other and stall the run, so the end applies —
      // the row's own end decision reaches the same outcome.
      if (s.status !== "done" || s.advancedAt !== undefined) return false;
      if (s.branch !== undefined) return !rows.some(j => j.branch === undefined && j.stepId === s.stepId && j.attempt === s.attempt);
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

/** Latest failed instance of a step on a run, if any.
 *  Returns null only when every failure is superseded by a later attempt of the
 *  same step+branch (N5). With several open failed branches, returns the earliest
 *  deterministically (startedAt, then branch name) — one branch at a time (G5). */
function latestFailedStep(ctx: Ctx, runId: string, stepId: string): StepRow | null {
  const steps = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId);
  const failed = steps.filter(s => s.status === "failed");
  const candidates = failed.filter(f =>
    !steps.some(s =>
      (f.branch === undefined ? s.branch === undefined : s.branch === f.branch)
      && s.attempt > f.attempt,
    ),
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    a.startedAt !== b.startedAt
      ? a.startedAt - b.startedAt
      : (a.branch ?? "").localeCompare(b.branch ?? ""),
  );
  return candidates[0]!;
}

function clearStepFailureWakeups(ctx: Ctx, row: StepRow): void {
  const ref = stepWakeRef(row.runId, row.stepId, row.attempt, row.branch);
  completeWakeupRef(ctx, row.runId, "step_failed", ref);
  completeWakeupRef(ctx, row.runId, "step_invalid", ref);
}

/** Grant op: skip a failed step (treat as done with `{ skipped: true }`) and advance. */
export async function skipFailedStep(
  ctx: Ctx,
  input: { runId: string; stepId: string },
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
  const result = { skipped: true };
  const done = updateStep(ctx, keyOf(row), { status: "done", result, endedAt: ctx.now });
  clearStepFailureWakeups(ctx, row);
  try {
    if (!isTerminal(getRun(ctx, run.id)) && getRun(ctx, run.id)?.status === "waiting") {
      await patchRun(ctx, run.id, { status: "running" });
    }
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  await advanceFrom(ctx, run.id, def, done, result, { deps, spawn });
  return getRun(ctx, run.id)!;
}

/** Grant op: retry a failed step by starting a new attempt. */
export async function retryFailedStep(
  ctx: Ctx,
  input: { runId: string; stepId: string },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${input.runId} is ${run.status}`);
  const row = latestFailedStep(ctx, input.runId, input.stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} of ${input.runId} is not failed`);
  // Cap retries per step — count prior retried failures (advancedAt), not loop
  // attempt numbers (S N5).
  const MAX_STEP_RETRIES = 3;
  const priorRetries = stepsOfRun(ctx, input.runId).filter(s =>
    s.stepId === input.stepId
    && (row.branch === undefined ? s.branch === undefined : s.branch === row.branch)
    && s.status === "failed"
    && s.advancedAt !== undefined,
  ).length;
  if (priorRetries >= MAX_STEP_RETRIES) {
    throw new CoreError("not_allowed", `step ${input.stepId} has reached the retry limit (${MAX_STEP_RETRIES})`);
  }
  const def = loadDefinition(ctx, run);
  if (!def?.steps[input.stepId]) throw new CoreError("not_found", `unknown step ${input.stepId}`);
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
  await startStep(ctx, getRun(ctx, run.id)!, def, input.stepId, row.branch, { deps, spawn });
  return getRun(ctx, run.id)!;
}

/** Answers a waiting human step: the answer becomes the step's result
 *  (`{ answer }`) and the run advances from it. */
export async function answerHumanStep(
  ctx: Ctx,
  runId: string,
  stepId: string,
  answer: string,
  expectRev: number,
  deps: EngineDeps = defaultEngineDeps,
  spawn?: SpawnRunner,
): Promise<RunRow> {
  if (typeof answer !== "string" || answer.length < 1) throw new CoreError("invalid_input", "answer must be a non-empty string");
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (RUN_TERMINAL.includes(run.status)) throw new CoreError("conflict", `conflict: run ${runId} is ${run.status}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  const waiting = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) throw new CoreError("conflict", `conflict: step ${stepId} of ${runId} is not waiting for an answer`);
  const def = loadDefinition(ctx, run);
  if (def?.steps[stepId]?.type !== "human") throw new CoreError("conflict", `conflict: step ${stepId} is not a human step`);
  // Defence: a run-grant caller may only answer auto-effective steps (run.decide path).
  // must / strict / auto-off steps stay person-only via run.answer.
  if (ctx.env.PACER_RUN_GRANT) {
    const stepDef = def.steps[stepId];
    // Auto flag lives on the root (choose_workflow children inherit it) — I2.
    const root = getRun(ctx, rootRunId(ctx, runId)) ?? run;
    if (!stepDef || stepDef.type !== "human" || !canAutoDecide(root, stepId, stepDef)) {
      throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
    }
  }
  // One yield before the claim: a concurrent answer (or a stopping run) can then
  // reach the same row, and it is claimStepAnswer below — not the luck of
  // synchronous execution — that makes the answer exclusive (round 4 review).
  await Promise.resolve();
  // Compare-and-set like claimStepSettlement: a second answer to the same waiting
  // step loses the race and is a conflict — it starts nothing.
  const claimed = claimStepAnswer(ctx, keyOf(row), { answer });
  if (!claimed) throw new CoreError("conflict", `conflict: step ${stepId} of ${runId} is not waiting for an answer`);
  // The answer is recorded: a conflicting run patch (the run went terminal, or a
  // concurrent writer moved its rev) must not fail the answer — it took effect and
  // advances below, or via the tick's re-advance when this advance is lost
  // (round 4 review).
  try {
    if (!isTerminal(getRun(ctx, runId))) await patchRun(ctx, runId, { status: "running" });
  } catch (err) {
    if (!(err instanceof CoreError) || err.code !== "conflict") throw err;
  }
  await advanceFrom(ctx, runId, def, claimed, { answer }, { deps, spawn });
  return getRun(ctx, runId)!;
}

/** Start a child run from an approved (or auto-approved) graph version. */
export async function startGeneratedChild(
  ctx: Ctx,
  input: { runId: string; stepId: string; version: number },
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
  const waiting = stepsOfRun(ctx, run.id).filter(s => s.stepId === input.stepId && s.status === "waiting");
  const latest = waiting[waiting.length - 1];
  if (!latest) throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a graph`);
  const priorChild = chooseStepChildRunId(latest.result);
  if (priorChild) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} already has child ${priorChild}`);
  }
  const prior = latest.result != null && typeof latest.result === "object"
    ? { ...(latest.result as Record<string, unknown>) }
    : {};
  if (prior.choosing === true) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is already starting a child`);
  }
  updateStep(ctx, keyOf(latest), {
    result: { ...prior, graphVersion: input.version, choosing: true, choosingAt: ctx.now, pendingApproval: undefined },
  });
  setGraphStatus(ctx, {
    runId: run.id, stepId: input.stepId, attempt: latest.attempt, version: input.version,
  }, "approved");
  const childDef = installGeneratedDefinition(ctx, run, input.stepId, input.version);
  const rootId = rootRunId(ctx, run.id);
  const root = getRun(ctx, rootId)!;
  let child: RunRow;
  try {
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
        updateStep(ctx, keyOf(latest), {
          result: { ...prior, graphVersion: input.version, pendingApproval: stepDef.approval ? true : undefined },
        });
        if (stepDef.approval) {
          setGraphStatus(ctx, {
            runId: run.id, stepId: input.stepId, attempt: latest.attempt, version: input.version,
          }, "proposed");
        }
      }
    } catch { /* */ }
    throw err;
  }
  updateStep(ctx, keyOf(latest), {
    result: {
      ...prior,
      graphVersion: input.version,
      childRunId: child.id,
      pendingApproval: undefined,
      choosing: undefined,
      choosingAt: undefined,
    },
  });
  completeWakeupRef(ctx, run.id, "orchestrator_step", stepWakeRef(run.id, input.stepId, latest.attempt));
  completeWakeupRef(ctx, run.id, "question", stepWakeRef(run.id, input.stepId, latest.attempt));
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
  if (!stepDef.approval) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} does not require approval`);
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
  const root = getRun(ctx, rootRunId(ctx, input.runId)) ?? run;
  if (ctx.env.PACER_RUN_GRANT) {
    if (!canAutoApproveGenerate(root, input.stepId, stepDef)) {
      throw new CoreError("not_allowed", "Orchestrator cannot answer this step (must, strict, or auto off)");
    }
  }
  const answer = input.answer.trim().toLowerCase();
  const isApprove = answer === "approve";
  const isRevise = answer === "revise" || answer.startsWith("revise");
  if (!isApprove && !isRevise) {
    throw new CoreError("invalid_input", "answer must be approve or revise");
  }
  if (isApprove) {
    await startGeneratedChild(ctx, {
      runId: input.runId,
      stepId: input.stepId,
      version: prior.graphVersion as number,
    }, spawn, deps);
    return getRun(ctx, input.runId)!;
  }
  const note = input.note
    ?? (answer.startsWith("revise:") || answer.startsWith("revise ")
      ? answer.replace(/^revise[:\s]+/i, "").trim()
      : "");
  const reviseCount = (typeof prior.reviseCount === "number" ? prior.reviseCount : 0) + 1;
  const retries = stepDef.retries ?? 2;
  setGraphStatus(ctx, {
    runId: run.id, stepId: input.stepId, attempt: row.attempt, version: prior.graphVersion as number,
  }, "rejected", note || undefined);
  if (reviseCount > retries) {
    updateStep(ctx, keyOf(row), {
      status: "failed",
      error: `generate revise failed after ${retries} retries`,
      endedAt: ctx.now,
      result: { ...prior, reviseCount, reviseNote: note || undefined, pendingApproval: undefined },
    });
    return getRun(ctx, input.runId)!;
  }
  updateStep(ctx, keyOf(row), {
    result: {
      ...prior,
      reviseCount,
      reviseNote: note || undefined,
      pendingApproval: undefined,
      graphVersion: undefined,
    },
  });
  enqueueWakeup(ctx, {
    runId: run.id,
    cause: "orchestrator_step",
    ref: stepWakeRef(run.id, input.stepId, row.attempt),
    createdAt: ctx.now,
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

/** Stops a run: every running or waiting step row is marked stopped, running step
 *  tasks are stopped through the task.stop op path, child runs are stopped, the
 *  root work node is settled, and the run itself is marked stopped. */
export async function stopRun(ctx: Ctx, runId: string, expectRev: number, deps: EngineDeps = defaultEngineDeps): Promise<RunRow> {
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
    if (row.taskId) {
      try { deps.stopTask(ctx, row.taskId); } catch { /* stopping the run must not depend on one task */ }
    }
    try { updateStep(ctx, keyOf(row), { status: "stopped", endedAt: ctx.now }); } catch { /* the row may have settled meanwhile */ }
  }
  const stopped = await patchRun(ctx, runId, { status: "stopped" });
  settleRootWorkNode(ctx, stopped, "stopped");
  return stopped;
}
