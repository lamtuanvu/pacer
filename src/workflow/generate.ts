// Generated sub-workflows: limits validation, versioned graph storage, and
// approval/child-run start (Phase 3). The grant op is Task 6.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { KINDS } from "../config/strategy";
import { publish } from "../link/publish";
import {
  addDefinition,
  getDefinition,
  getGraph,
  getRun,
  insertGraphVersion,
  listGraphs,
  runEntityValue,
  setGraphStatus,
  stepsOfRun,
  updateRun,
  updateStep,
  workflowDatabase,
  type RunRow,
  type StepKey,
  type StepRow,
} from "./store";
import {
  isPlainObject,
  type GenerateLimits,
  type GenerateStep,
  type WorkflowDef,
  type WorkflowError,
} from "./schema";
import { backEdgeIndexes, validateWorkflow } from "./validate";
import { enqueueWakeup, stepWakeRef } from "./wakeups";
import type { SpawnRunner } from "../tasks/api";

const KNOWN_KINDS = new Set<string>(KINDS);

/** Cap validation errors returned/stored so a hostile graph cannot flood the step result. */
const MAX_GENERATE_ERRORS = 32;

/** Narrow deps shape so generate.ts does not import engine (cycle). */
export type GenerateEngineDeps = {
  delegate: (ctx: Ctx, input: import("../tasks/api").DelegateInput, spawn?: SpawnRunner) => Promise<import("../tasks/types").TaskRecord>;
  stopTask: (ctx: Ctx, id: string) => void;
};

/** Parse `kind in [a, b]` or a bare kind name into the set of matching kinds. */
function kindsFromPredicate(key: string): Set<string> | null {
  const trimmed = key.trim();
  const m = /^kind\s+in\s*\[([^\]]*)\]$/i.exec(trimmed);
  if (m) {
    return new Set(
      m[1]!.split(",").map(s => s.trim()).filter(Boolean),
    );
  }
  if (/^[\w.-]+$/.test(trimmed)) return new Set([trimmed]);
  return null;
}

/** Forward adjacency only (excludes back edges) so require_after cannot be satisfied by a retry loop. */
function forwardAdjacency(def: WorkflowDef): Map<string, string[]> {
  const backs = backEdgeIndexes(def);
  const map = new Map<string, string[]>();
  def.edges.forEach((edge, index) => {
    if (backs.has(index)) return;
    if (typeof edge?.from !== "string" || typeof edge?.to !== "string") return;
    const list = map.get(edge.from) ?? [];
    list.push(edge.to);
    map.set(edge.from, list);
  });
  return map;
}

function isReviewer(step: unknown): boolean {
  return isPlainObject(step) && step.type === "agent" && step.role === "reviewer";
}

function reviewerHasCriterion(step: unknown): boolean {
  if (!isReviewer(step) || !isPlainObject(step)) return false;
  const result = step.result;
  if (!isPlainObject(result) || !Array.isArray(result.required)) return false;
  return result.required.includes("verdict");
}

function agentKind(step: unknown): string | undefined {
  if (!isPlainObject(step) || step.type !== "agent") return undefined;
  return typeof step.kind === "string" ? step.kind : undefined;
}

/** Effective kind for limits checks: agent.kind or fanout.each.kind. */
function stepKindForLimits(step: unknown): string | undefined {
  if (!isPlainObject(step)) return undefined;
  if (step.type === "agent") return agentKind(step);
  if (step.type === "fanout" && isPlainObject(step.each)) return agentKind(step.each);
  return undefined;
}

/** Count runnable work units: fanout counts as its branch count; other non-end steps count as 1. */
function effectiveStepBudget(def: WorkflowDef): number {
  let n = 0;
  for (const step of Object.values(def.steps ?? {})) {
    if (!step || step.type === "end") continue;
    if (step.type === "fanout") n += Math.max(1, step.branches?.length ?? 1);
    else n += 1;
  }
  for (const edge of def.edges ?? []) {
    if (typeof edge.maxLoops === "number" && Number.isFinite(edge.maxLoops)) n += edge.maxLoops;
  }
  return n;
}

/** Count runnable steps (everything except `end`) — used for graph summaries. */
function runnableStepCount(def: WorkflowDef): number {
  return Object.values(def.steps).filter(s => s?.type !== "end").length;
}

/**
 * Every forward path from `start`'s successors must hit a reviewer before end.
 * Edges with `when` are included as possible paths (honouring conditionals).
 */
function allPathsHitReviewer(
  start: string,
  steps: WorkflowDef["steps"],
  adj: Map<string, string[]>,
): boolean {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const ok = (node: string): boolean => {
    if (isReviewer(steps[node])) return true;
    if (steps[node]?.type === "end") return false;
    if (memo.has(node)) return memo.get(node)!;
    if (visiting.has(node)) return true; // cycle with no end: not a bypass of the reviewer
    visiting.add(node);
    const nexts = adj.get(node) ?? [];
    const result = nexts.length > 0 && nexts.every(n => ok(n));
    memo.set(node, result);
    visiting.delete(node);
    return result;
  };
  const nexts = adj.get(start) ?? [];
  return nexts.length > 0 && nexts.every(n => ok(n));
}

function capErrors(errors: WorkflowError[]): WorkflowError[] {
  return errors.length <= MAX_GENERATE_ERRORS ? errors : errors.slice(0, MAX_GENERATE_ERRORS);
}

/** Force generated human gates to `must` so the orchestrator cannot auto-answer its own graph. */
export function forceGeneratedHumanMust(graph: WorkflowDef): WorkflowDef {
  let changed = false;
  const steps: WorkflowDef["steps"] = { ...graph.steps };
  for (const [id, step] of Object.entries(steps)) {
    if (step?.type === "human" && step.decision === "auto") {
      steps[id] = { ...step, decision: "must" };
      changed = true;
    }
  }
  return changed ? { ...graph, steps } : graph;
}

/**
 * Validate a generated graph against the produce step's limits, on top of
 * `validateWorkflow`. Every violation is returned at once; nothing is stored.
 */
export function validateGenerated(
  graph: WorkflowDef,
  limits: GenerateLimits,
  depth: number,
): WorkflowError[] {
  const errors: WorkflowError[] = [...validateWorkflow(graph)];
  const maxDepth = limits.max_depth ?? 2;
  if (depth > maxDepth) {
    errors.push({ path: "limits.max_depth", message: `generated depth ${depth} exceeds max_depth ${maxDepth}` });
  }

  const allowedTypes = new Set<string>(limits.step_types);
  const steps = graph.steps ?? {};
  const runnable = runnableStepCount(graph);
  if (runnable === 0 || graph.entry === undefined || steps[graph.entry]?.type === "end") {
    errors.push({ path: "steps", message: "generated graph has no work (end-only / empty work is refused)" });
  }

  const budget = effectiveStepBudget(graph);
  if (budget > limits.max_steps) {
    errors.push({
      path: "steps",
      message: `too many steps: effective budget ${budget} exceeds max_steps ${limits.max_steps}`,
    });
  }

  for (const [index, edge] of (graph.edges ?? []).entries()) {
    if (typeof edge.maxLoops === "number" && edge.maxLoops > limits.max_steps) {
      errors.push({
        path: `edges[${index}].maxLoops`,
        message: `max_loops ${edge.maxLoops} exceeds max_steps ${limits.max_steps}`,
      });
    }
  }

  for (const [id, step] of Object.entries(steps)) {
    if (!step) continue;
    if (step.type === "end") continue;
    if (!allowedTypes.has(step.type)) {
      errors.push({ path: `steps.${id}.type`, message: `step type '${step.type}' is not allowed by limits.step_types` });
    }
    if (step.type === "agent") {
      if (step.role === "orchestrator") {
        errors.push({
          path: `steps.${id}.role`,
          message: "role: orchestrator is not allowed in generated graphs",
        });
      }
      if (step.interactive === true) {
        errors.push({
          path: `steps.${id}.interactive`,
          message: "interactive is not allowed in generated graphs",
        });
      }
      if (step.role === "reviewer") {
        if (!reviewerHasCriterion(step)) {
          errors.push({
            path: `steps.${id}.result`,
            message: "role: reviewer must declare result.required including 'verdict' (reviewer criterion)",
          });
        }
      } else if (!agentKind(step)) {
        errors.push({
          path: `steps.${id}.kind`,
          message: "kind is required for non-reviewer agent steps in generated graphs",
        });
      }
    }
    const kind = stepKindForLimits(step);
    if (kind) {
      if (limits.kinds) {
        if (!limits.kinds.includes(kind)) {
          const path = step.type === "fanout" ? `steps.${id}.each.kind` : `steps.${id}.kind`;
          errors.push({ path, message: `kind '${kind}' is not allowed by limits.kinds` });
        }
      } else if (!KNOWN_KINDS.has(kind)) {
        // M3: refuse unknown kinds at validate time (not only at delegate).
        const path = step.type === "fanout" ? `steps.${id}.each.kind` : `steps.${id}.kind`;
        errors.push({
          path,
          message: `unknown kind '${kind}' (allowed: ${KINDS.join(", ")})`,
        });
      }
    }
    if (step.type === "fanout" && step.branches.length > limits.max_steps) {
      errors.push({
        path: `steps.${id}.branches`,
        message: `fanout branches ${step.branches.length} exceed max_steps ${limits.max_steps}`,
      });
    }
  }

  const adj = forwardAdjacency(graph);
  if (limits.require_after) {
    for (const [predicate, role] of Object.entries(limits.require_after)) {
      if (role !== "reviewer") continue;
      const kinds = kindsFromPredicate(predicate);
      if (!kinds) {
        errors.push({ path: "limits.require_after", message: `unrecognized require_after predicate '${predicate}'` });
        continue;
      }
      for (const [id, step] of Object.entries(steps)) {
        const kind = stepKindForLimits(step);
        if (!kind || !kinds.has(kind)) continue;
        if (!allPathsHitReviewer(id, steps, adj)) {
          errors.push({
            path: `steps.${id}`,
            message: `require_after: step '${id}' (kind ${kind}) has no following reviewer on every path`,
          });
        }
      }
    }
  }

  if (limits.require_last) {
    const required = limits.require_last.kind;
    const ends = Object.entries(steps).filter(([, s]) => s?.type === "end").map(([id]) => id);
    let reported = false;
    for (const endId of ends) {
      const preds = graph.edges.filter(e => e.to === endId).map(e => e.from);
      if (preds.length === 0) continue;
      const ok = preds.every(id => stepKindForLimits(steps[id]) === required);
      if (ok) continue;
      if (!reported) {
        errors.push({
          path: "steps",
          message: `require_last: step before end must have kind '${required}'`,
        });
        reported = true;
      }
    }
    if (!reported && ends.length === 0) {
      errors.push({
        path: "steps",
        message: `require_last: step before end must have kind '${required}'`,
      });
    }
  }

  return capErrors(errors);
}

function latestWaitingGenerate(ctx: Ctx, runId: string, stepId: string): StepRow | undefined {
  const waiting = stepsOfRun(ctx, runId).filter(s => s.stepId === stepId && s.status === "waiting");
  return waiting[waiting.length - 1];
}

function keyOf(s: StepRow): StepKey {
  return { runId: s.runId, stepId: s.stepId, attempt: s.attempt, ...(s.branch !== undefined ? { branch: s.branch } : {}) };
}

function nestingDepth(ctx: Ctx, runId: string): number {
  let depth = 0;
  let id: string | undefined = runId;
  while (id) {
    const run = getRun(ctx, id);
    if (!run?.parentRunId) break;
    depth += 1;
    id = run.parentRunId;
  }
  // The graph being submitted becomes a child of this run's generate step.
  return depth + 1;
}

export interface SubmitGraphResult {
  ok: boolean;
  errors: WorkflowError[];
  version?: number;
}

function stepResultObj(row: StepRow): Record<string, unknown> {
  return row.result != null && typeof row.result === "object" && !Array.isArray(row.result)
    ? { ...(row.result as Record<string, unknown>) }
    : {};
}

/** Install a unique child workflow definition from an approved graph version. */
export function installGeneratedDefinition(
  ctx: Ctx,
  run: RunRow,
  stepId: string,
  version: number,
): WorkflowDef {
  const row = latestWaitingGenerate(ctx, run.id, stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${stepId} is not waiting`);
  const graph = getGraph(ctx, { runId: run.id, stepId, attempt: row.attempt, version });
  if (!graph) throw new CoreError("not_found", `unknown graph version ${version}`);
  // Attempt-scoped so a later generate attempt can reuse v1 without colliding.
  const childId = `gen/${run.id}/${stepId}/a${row.attempt}/v${version}`;
  const childDef: WorkflowDef = { ...graph.def, id: childId, version: 1 };
  const source = JSON.stringify(childDef);
  addDefinition(ctx, childDef, source);
  return childDef;
}

/**
 * Count shape/parse or validation errors toward generate retries. Used by the
 * submit_graph op when parse/shape fails before submitGraph, and by submitGraph
 * itself for validateGenerated failures.
 */
export function noteGenerateSubmitErrors(
  ctx: Ctx,
  runId: string,
  stepId: string,
  errors: WorkflowError[],
): SubmitGraphResult {
  const run = getRun(ctx, runId);
  if (!run) throw new CoreError("not_found", `unknown run ${runId}`);
  const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
  const stepDef = def?.steps[stepId];
  if (!stepDef || stepDef.type !== "generate") {
    throw new CoreError("conflict", `conflict: step ${stepId} is not a generate step`);
  }
  const row = latestWaitingGenerate(ctx, runId, stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${stepId} is not waiting for a graph`);
  const prior = stepResultObj(row);
  if (prior.choosing === true) {
    throw new CoreError("conflict", `conflict: step ${stepId} is already starting a child`);
  }
  const priorFails = typeof prior.submitFails === "number" ? prior.submitFails : 0;
  const submitFails = priorFails + 1;
  const retries = stepDef.retries ?? 2;
  if (submitFails > retries) {
    updateStep(ctx, keyOf(row), {
      status: "failed",
      error: `generate validation failed after ${retries} retries`,
      endedAt: ctx.now,
      result: { ...prior, submitFails, errors, pendingApproval: undefined, reviseNote: undefined },
    });
    enqueueWakeup(ctx, {
      runId: run.id,
      cause: "step_failed",
      ref: stepWakeRef(run.id, stepId, row.attempt),
      createdAt: ctx.now,
    });
  } else {
    updateStep(ctx, keyOf(row), { result: { ...prior, submitFails, errors } });
  }
  try { updateRun(ctx, run.id, run.rev, {}); } catch { /* best-effort rev bump */ }
  return { ok: false, errors };
}

/**
 * Validate and store a generated graph for a waiting `generate` step.
 * With no `approval`, starts the child run at once. With `approval: must|auto`,
 * leaves the graph proposed until approve/revise.
 */
export async function submitGraph(
  ctx: Ctx,
  input: { runId: string; stepId: string; source: WorkflowDef },
  deps?: GenerateEngineDeps,
  spawn?: SpawnRunner,
): Promise<SubmitGraphResult> {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
  const stepDef = def?.steps[input.stepId];
  if (!stepDef || stepDef.type !== "generate") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not a generate step`);
  }
  const row = latestWaitingGenerate(ctx, input.runId, input.stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a graph`);
  const prior = stepResultObj(row);
  if (typeof prior.childRunId === "string") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} already has a child run`);
  }
  if (prior.choosing === true) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is already starting a child`);
  }
  if (prior.pendingApproval === true) {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is waiting for approval`);
  }

  const depth = nestingDepth(ctx, run.id);
  const source = forceGeneratedHumanMust(input.source);
  const errors = validateGenerated(source, stepDef.limits, depth);
  // Re-plan submissions must keep finished step ids unchanged.
  const finished = Array.isArray(prior.replanFinished)
    ? (prior.replanFinished as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  const priorGraphs = listGraphs(ctx, run.id, input.stepId);
  const baseline = [...priorGraphs].reverse().find(g =>
    g.status === "approved" || g.status === "superseded" || g.status === "rejected" || g.status === "proposed",
  );
  if (finished.length > 0 && baseline) {
    const { validateReplanKeepFinished } = await import("./replan");
    errors.push(...validateReplanKeepFinished(baseline.def, source, finished));
  }
  if (errors.length > 0) {
    return noteGenerateSubmitErrors(ctx, input.runId, input.stepId, capErrors(errors));
  }

  const { graphDiff, formatReplanSummary } = await import("./replan");
  const diff = baseline ? graphDiff(baseline.def, source) : { added: [] as string[], removed: [] as string[], changed: [] as string[] };
  const failedStep = typeof prior.replanFailedStep === "string" ? prior.replanFailedStep : "";
  const replanSummary = prior.replanMode
    ? formatReplanSummary(diff, failedStep || "(unknown)")
    : undefined;
  const replanAsk = prior.replanMode === "ask";

  // M2: re-check + insert + step update + rev bump in one immediate transaction so
  // two concurrent submits cannot both pass the pre-checks above.
  const stored = workflowDatabase(ctx).transaction(() => {
    const freshRow = latestWaitingGenerate(ctx, input.runId, input.stepId);
    if (!freshRow || freshRow.attempt !== row.attempt) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a graph`);
    }
    const freshPrior = stepResultObj(freshRow);
    if (typeof freshPrior.childRunId === "string") {
      throw new CoreError("conflict", `conflict: step ${input.stepId} already has a child run`);
    }
    if (freshPrior.choosing === true) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} is already starting a child`);
    }
    if (freshPrior.pendingApproval === true) {
      throw new CoreError("conflict", `conflict: step ${input.stepId} is waiting for approval`);
    }
    const graph = insertGraphVersion(ctx, {
      runId: run.id,
      stepId: input.stepId,
      attempt: freshRow.attempt,
      def: source,
      status: "proposed",
    });
    const nextResult: Record<string, unknown> = {
      ...freshPrior,
      graphVersion: graph.version,
      submitFails: 0,
      reviseNote: undefined,
      replanDiff: freshPrior.replanMode ? diff : freshPrior.replanDiff,
      ...(replanSummary !== undefined ? { replanSummary } : {}),
    };
    if (replanAsk || stepDef.approval) {
      updateStep(ctx, keyOf(freshRow), {
        result: {
          ...nextResult,
          pendingApproval: true,
          approval: replanAsk ? (stepDef.approval ?? "must") : stepDef.approval,
        },
      });
    } else {
      updateStep(ctx, keyOf(freshRow), {
        result: { ...nextResult, pendingApproval: undefined },
      });
    }
    const live = getRun(ctx, run.id);
    if (live) {
      try { updateRun(ctx, run.id, live.rev, {}); } catch { /* */ }
    }
    return graph;
  }).immediate();

  const published = getRun(ctx, run.id);
  if (published) {
    try {
      await publish(ctx, [{ type: "entity", data: { kind: "run", id: published.id, value: runEntityValue(published) } }]);
    } catch { /* publishing must never throw into submit */ }
  }

  // Replan ask / approval: person or auto-wake before the child starts.
  if (replanAsk || stepDef.approval) {
    if (stepDef.approval === "auto" && !replanAsk) {
      const { canAutoApproveGenerate } = await import("./auto");
      const { rootRunId } = await import("./store");
      const root = getRun(ctx, rootRunId(ctx, run.id)) ?? run;
      if (canAutoApproveGenerate(root, input.stepId, stepDef)) {
        enqueueWakeup(ctx, {
          runId: run.id,
          cause: "question",
          ref: stepWakeRef(run.id, input.stepId, row.attempt),
          createdAt: ctx.now,
        });
      }
    }
    return { ok: true, errors: [], version: stored.version };
  }

  const { startGeneratedChild } = await import("./engine");
  await startGeneratedChild(ctx, {
    runId: run.id,
    stepId: input.stepId,
    version: stored.version,
  }, spawn, deps);
  return { ok: true, errors: [], version: stored.version };
}

/** Latest proposed graph version for a waiting generate step, if any. */
export function pendingGraphVersion(ctx: Ctx, runId: string, stepId: string): number | undefined {
  const row = latestWaitingGenerate(ctx, runId, stepId);
  if (!row) return undefined;
  const version = stepResultObj(row).graphVersion;
  return typeof version === "number" ? version : undefined;
}

export function listGraphSummaries(ctx: Ctx, runId: string): {
  stepId: string;
  attempt: number;
  version: number;
  status: string;
  stepCount: number;
}[] {
  return listGraphs(ctx, runId).map(g => ({
    stepId: g.stepId,
    attempt: g.attempt,
    version: g.version,
    status: g.status,
    stepCount: runnableStepCount(g.def),
  }));
}

export type { GenerateStep, GenerateLimits };
