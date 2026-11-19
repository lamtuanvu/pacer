// The run engine: it starts runs, turns agent, human and fanout steps into ordinary
// pacer tasks, settles step instances from task settlement, evaluates conditional and
// bounded back edges, and joins fan-outs. All run changes go through updateRun with
// the current rev; a step instance links to its task only through a workflow_steps
// row, so ordinary tasks are untouched (spec, "Scope").
//
// Delegation and stopping are injectable (EngineDeps) so unit tests can create and
// settle tasks with createTask/updateTask instead of spawning runners; the defaults
// mirror the task.stop op path (getWork ? stopWork : core.tasks.stop).
import type { Ctx } from "../types";
import type { SpawnRunner } from "../tasks/api";
import { delegate as delegateTask, stop as stopTaskCore } from "../core/tasks";
import { stopWork } from "../core/work";
import { getWork } from "../dispatch/work";
import { readTask } from "../tasks/store";
import type { TaskState } from "../tasks/types";
import { CoreError } from "../core/errors";
import { backEdgeIndexes } from "./validate";
import { evalCondition, parseCondition } from "./condition";
import { renderPrompt } from "./template";
import {
  getDefinition, getRun, insertRun, insertStep, stepByTask, stepsOfRun, updateRun, updateStep,
  type RunPatch, type RunRow, type StepKey, type StepRow,
} from "./store";
import { isPlainObject, type AgentStep, type FanoutStep, type JsonSchemaLite, type WorkflowDef } from "./schema";

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

function patchRun(ctx: Ctx, runId: string, patch: RunPatch): RunRow {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  return updateRun(ctx, runId, run.rev, patch);
}

/** Fails a run with a reason (and optionally the loop counters that led there). */
export function failRun(ctx: Ctx, runId: string, reason: string, loops?: Record<string, number>): void {
  patchRun(ctx, runId, { status: "failed", reason, ...(loops ? { loops } : {}) });
}

function loadDefinition(ctx: Ctx, run: RunRow): WorkflowDef | null {
  return getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
}

/** Starts one step instance: agent steps delegate a task (idempotent per instance
 *  through an active-row check and the request id), human steps wait, fan-outs
 *  delegate one task per branch. */
export async function startStep(ctx: Ctx, run: RunRow, def: WorkflowDef, stepId: string, branch?: string, o?: StartOptions): Promise<StepRow> {
  const e = withDefaults(o);
  const stepDef = def.steps[stepId];
  if (!stepDef) throw new CoreError("not_found", `workflow '${def.id}' has no step '${stepId}'`);
  if (stepDef.type === "end") throw new CoreError("invalid_input", `step '${stepId}' is an end step and never runs as a task`);
  if (stepDef.type !== "fanout") {
    const active = stepsOfRun(ctx, run.id).find(s =>
      s.stepId === stepId && (s.branch ?? undefined) === (branch ?? undefined) && (s.status === "running" || s.status === "waiting"));
    if (active) return active; // An instance is already in flight: never start it twice.
  }
  const attempt = nextAttempt(ctx, run.id, stepId);
  if (stepDef.type === "human") {
    const row = insertStep(ctx, { runId: run.id, stepId, attempt, status: "waiting" });
    patchRun(ctx, run.id, { status: "waiting" });
    return row;
  }
  if (stepDef.type === "fanout") return startFanout(ctx, run, stepId, stepDef, attempt, e);
  return startAgentStep(ctx, run, def, stepId, stepDef, branch, attempt, e);
}

async function startAgentStep(ctx: Ctx, run: RunRow, def: WorkflowDef, stepId: string, stepDef: AgentStep, branch: string | undefined, attempt: number, e: EngineOptions): Promise<StepRow> {
  const prompt = renderPrompt(stepDef.prompt, {
    brief: run.brief,
    steps: stepResults(ctx, run.id),
    branch,
    run: { id: run.id, stepId },
  });
  const task = await e.deps.delegate(ctx, {
    brief: { goal: prompt, repo: run.repo },
    kind: stepDef.kind,
    ...(stepDef.difficulty ? { difficulty: stepDef.difficulty } : {}),
    title: stepTitle(run, stepId, branch),
    requestId: `wf:${run.id}:${stepId}:${attempt}:${branch ?? ""}`,
  }, e.spawn);
  return insertStep(ctx, { runId: run.id, stepId, attempt, branch, taskId: task.id, status: "running" });
}

async function startFanout(ctx: Ctx, run: RunRow, stepId: string, stepDef: FanoutStep, attempt: number, e: EngineOptions): Promise<StepRow> {
  let first: StepRow | undefined;
  for (const branch of stepDef.branches) {
    const active = stepsOfRun(ctx, run.id).find(s =>
      s.stepId === stepId && s.branch === branch && (s.status === "running" || s.status === "waiting"));
    if (active) {
      first ??= active;
      continue;
    }
    const prompt = renderPrompt(stepDef.each.prompt, {
      brief: run.brief,
      steps: stepResults(ctx, run.id),
      branch,
      run: { id: run.id, stepId },
    });
    const task = await e.deps.delegate(ctx, {
      brief: { goal: prompt, repo: run.repo },
      kind: stepDef.each.kind,
      ...(stepDef.each.difficulty ? { difficulty: stepDef.each.difficulty } : {}),
      title: stepTitle(run, stepId, branch),
      requestId: `wf:${run.id}:${stepId}:${attempt}:${branch}`,
    }, e.spawn);
    const row = insertStep(ctx, { runId: run.id, stepId, attempt, branch, taskId: task.id, status: "running" });
    first ??= row;
  }
  return first!;
}

/** Starts a run: creates the run record and starts its entry step. A failing start
 *  fails the run (never leaves it silently stuck) and rethrows. */
export async function startRun(
  ctx: Ctx,
  input: { workflow: string; repo: string; brief: string; title?: string },
  spawn?: SpawnRunner,
  deps: EngineDeps = defaultEngineDeps,
): Promise<RunRow> {
  const def = getDefinition(ctx, input.workflow);
  if (!def) throw new CoreError("not_found", `unknown workflow '${input.workflow}'`);
  if (typeof input.brief !== "string" || !input.brief.trim()) throw new CoreError("invalid_input", "brief is required");
  if (typeof input.repo !== "string" || !input.repo) throw new CoreError("invalid_input", "repo is required");
  const run = insertRun(ctx, { workflow: def.id, version: def.version, repo: input.repo, brief: input.brief, title: input.title });
  try {
    if (def.steps[def.entry]?.type === "end") patchRun(ctx, run.id, { status: "done" });
    else await startStep(ctx, getRun(ctx, run.id)!, def, def.entry, undefined, { deps, spawn });
  } catch (e) {
    failRun(ctx, run.id, `start failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  return getRun(ctx, run.id) ?? run;
}

function resultErrors(result: unknown, schema: JsonSchemaLite | undefined): string[] {
  if (!isPlainObject(result)) return ["result must be a JSON object"];
  return (schema?.required ?? []).filter(key => !(key in result)).map(key => `missing required key '${key}'`);
}

/** Records an agent step's structured result before settlement. Validated at once
 *  against the step's declared schema so the agent can fix it in the same turn
 *  (spec, "Returning a step result"). */
export function recordStepResult(ctx: Ctx, taskId: string, result: unknown): StepRow {
  const step = stepByTask(ctx, taskId);
  if (!step) throw new CoreError("not_found", `task ${taskId} is not a workflow step`);
  if (step.status !== "running") throw new CoreError("conflict", `conflict: step ${step.stepId} is not running`);
  if (step.result !== undefined) throw new CoreError("conflict", `conflict: step ${step.stepId} already has a result`);
  const run = getRun(ctx, step.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${step.runId}`);
  const stepDef = loadDefinition(ctx, run)?.steps[step.stepId];
  const schema = stepDef?.type === "agent" ? stepDef.result : stepDef?.type === "fanout" ? stepDef.each.result : undefined;
  const errors = resultErrors(result, schema);
  if (errors.length > 0) throw new CoreError("invalid_input", errors.join("; "));
  return updateStep(ctx, keyOf(step), { result });
}

/** Settles the step instance a task belongs to and advances its run. A no-op when
 *  the task has no step row, the task is not settled yet, or the step already
 *  settled (Review Focus 1 and 3). */
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
  const done = task.state === "done" && step.result !== undefined;
  const error = done ? undefined : task.state === "done" ? "no step result" : task.state;
  const row = updateStep(ctx, keyOf(step), done ? { status: "done", endedAt: ctx.now } : { status: "failed", error, endedAt: ctx.now });
  if (RUN_TERMINAL.includes(run.status)) return; // A terminal run only records the bookkeeping.
  const stepDef = def.steps[step.stepId];
  if (stepDef?.type === "fanout") {
    await joinFanout(ctx, run, def, step, stepDef, { deps, spawn });
    return;
  }
  if (row.status === "failed") {
    failRun(ctx, run.id, `step ${step.stepId} ${error}`);
    return;
  }
  await advanceFrom(ctx, run.id, def, step.stepId, step.result, { deps, spawn });
}

/** Evaluates the join rule across a fan-out attempt's branches; a resolved join is
 *  recorded as the attempt's branch-less row, which is both the joined result and
 *  the marker that the fan-out already advanced. */
async function joinFanout(ctx: Ctx, run: RunRow, def: WorkflowDef, settled: StepRow, stepDef: FanoutStep, e: EngineOptions): Promise<void> {
  const rows = stepsOfRun(ctx, run.id).filter(s => s.stepId === settled.stepId && s.attempt === settled.attempt);
  const branches = rows.filter(s => s.branch !== undefined);
  const join = rows.find(s => s.branch === undefined);
  if (join && (join.status === "done" || join.status === "failed")) return;
  const done = branches.filter(b => b.status === "done");
  const failed = branches.filter(b => b.status === "failed");
  const running = branches.filter(b => b.status === "running" || b.status === "waiting");
  let outcome: "done" | "failed" | null = null;
  if (stepDef.join === "all") outcome = failed.length > 0 ? "failed" : running.length === 0 ? "done" : null;
  else if (stepDef.join === "any") outcome = done.length > 0 ? "done" : running.length === 0 ? "failed" : null;
  else {
    const quorum = stepDef.join.quorum;
    if (done.length >= quorum) outcome = "done";
    else if (done.length + running.length < quorum) outcome = "failed";
  }
  if (!outcome) return;
  if (stepDef.join === "any" && outcome === "done") {
    for (const b of running) {
      if (!b.taskId) continue;
      try { e.deps.stopTask(ctx, b.taskId); } catch { /* the join must not depend on one stop */ }
    }
  }
  const result = {
    branches: Object.fromEntries(branches.map(b => [b.branch!, b.result ?? null])),
    done: done.length,
    failed: failed.length,
  };
  const joinRow = insertStep(ctx, { runId: run.id, stepId: settled.stepId, attempt: settled.attempt, status: outcome });
  updateStep(ctx, keyOf(joinRow), { result, endedAt: ctx.now });
  if (outcome === "failed") {
    failRun(ctx, run.id, `step ${settled.stepId} ${failed[0]?.error ?? "failed"}`);
    return;
  }
  await advanceFrom(ctx, run.id, def, settled.stepId, result, e);
}

/** Follows a finished step's outgoing edges: every edge whose `when` holds (an edge
 *  without one always fires) starts its target; a back edge counts against
 *  `maxLoops`; no match or an exceeded loop fails the run; an `end` target ends it. */
async function advanceFrom(ctx: Ctx, runId: string, def: WorkflowDef, stepId: string, result: unknown, e: EngineOptions): Promise<void> {
  const run = getRun(ctx, runId);
  if (!run || RUN_TERMINAL.includes(run.status)) return;
  const back = backEdgeIndexes(def);
  const matched: { edge: (typeof def.edges)[number]; index: number }[] = [];
  def.edges.forEach((edge, index) => {
    if (edge.from !== stepId) return;
    if (edge.when !== undefined) {
      const parsed = parseCondition(edge.when);
      if (!parsed.ast || !evalCondition(parsed.ast, { result, brief: run.brief })) return;
    }
    matched.push({ edge, index });
  });
  if (matched.length === 0) {
    failRun(ctx, runId, `no edge matched after ${stepId}`);
    return;
  }
  for (const { edge, index } of matched) {
    const target = def.steps[edge.to];
    if (!target) {
      failRun(ctx, runId, `unknown step '${edge.to}' after ${stepId}`);
      return;
    }
    if (back.has(index)) {
      const key = `${edge.from}->${edge.to}`;
      const current = getRun(ctx, runId)!;
      const loops = { ...current.loops, [key]: (current.loops[key] ?? 0) + 1 };
      if (loops[key] > (edge.maxLoops ?? 0)) {
        failRun(ctx, runId, `loop limit ${key}`, loops);
        return;
      }
      patchRun(ctx, runId, { loops });
    }
    if (target.type === "end") {
      patchRun(ctx, runId, { status: "done" });
      return;
    }
    try {
      await startStep(ctx, getRun(ctx, runId)!, def, edge.to, undefined, e);
    } catch (err) {
      // A start failure ends the run (no eligible executor, validation, …): it
      // must never escape advanceFrom, where it would stall the change cursor
      // and block every other run's settlement (Review Focus 3).
      failRun(ctx, runId, `start failed: ${edge.to}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }
}

/** Answers a waiting human step: the answer becomes the step's result
 *  (`{ answer }`) and the run advances from it. */
export async function answerHumanStep(ctx: Ctx, runId: string, stepId: string, answer: string, expectRev: number, deps: EngineDeps = defaultEngineDeps): Promise<RunRow> {
  if (typeof answer !== "string" || answer.length < 1) throw new CoreError("invalid_input", "answer must be a non-empty string");
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  const waiting = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) throw new CoreError("conflict", `conflict: step ${stepId} of ${runId} is not waiting for an answer`);
  const def = loadDefinition(ctx, run);
  if (def?.steps[stepId]?.type !== "human") throw new CoreError("conflict", `conflict: step ${stepId} is not a human step`);
  updateStep(ctx, keyOf(row), { status: "done", result: { answer }, endedAt: ctx.now });
  patchRun(ctx, runId, { status: "running" });
  await advanceFrom(ctx, runId, def, stepId, { answer }, { deps, spawn: undefined });
  return getRun(ctx, runId)!;
}

/** Stops a run: every running step task is stopped through the task.stop op path,
 *  and the run itself is marked stopped. */
export function stopRun(ctx: Ctx, runId: string, expectRev: number, deps: EngineDeps = defaultEngineDeps): RunRow {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  if (run.rev !== expectRev) throw new CoreError("conflict", `conflict: run ${runId} changed since rev ${expectRev}`);
  for (const row of stepsOfRun(ctx, runId)) {
    if (row.status !== "running" || !row.taskId) continue;
    try { deps.stopTask(ctx, row.taskId); } catch { /* stopping the run must not depend on one task */ }
  }
  return updateRun(ctx, runId, expectRev, { status: "stopped" });
}
