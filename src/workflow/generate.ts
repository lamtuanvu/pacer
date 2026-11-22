// Generated sub-workflows: limits validation and versioned graph storage.
// Approval and child-run start are Phase 3 Task 4; the grant op is Task 6.
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import {
  getDefinition,
  getRun,
  insertGraphVersion,
  stepsOfRun,
  updateStep,
  type StepKey,
  type StepRow,
} from "./store";
import {
  isPlainObject,
  type AgentStep,
  type GenerateLimits,
  type GenerateStep,
  type WorkflowDef,
  type WorkflowError,
} from "./schema";
import { validateWorkflow } from "./validate";

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

function adjacency(def: WorkflowDef): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of def.edges) {
    if (typeof edge?.from !== "string" || typeof edge?.to !== "string") continue;
    const list = map.get(edge.from) ?? [];
    list.push(edge.to);
    map.set(edge.from, list);
  }
  return map;
}

function reachableFrom(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const next of adj.get(queue.shift()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function isReviewer(step: unknown): boolean {
  return isPlainObject(step) && step.type === "agent" && step.role === "reviewer";
}

function agentKind(step: unknown): string | undefined {
  if (!isPlainObject(step) || step.type !== "agent") return undefined;
  return typeof step.kind === "string" ? step.kind : undefined;
}

/** Count runnable steps (everything except `end`). */
function runnableStepCount(def: WorkflowDef): number {
  return Object.values(def.steps).filter(s => s?.type !== "end").length;
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
  if (runnable > limits.max_steps) {
    errors.push({ path: "steps", message: `too many steps: ${runnable} exceeds max_steps ${limits.max_steps}` });
  }

  for (const [id, step] of Object.entries(steps)) {
    if (!step) continue;
    if (step.type === "end") continue;
    if (!allowedTypes.has(step.type)) {
      errors.push({ path: `steps.${id}.type`, message: `step type '${step.type}' is not allowed by limits.step_types` });
    }
    if (step.type === "agent" && limits.kinds) {
      const kind = agentKind(step);
      if (kind && !limits.kinds.includes(kind)) {
        errors.push({ path: `steps.${id}.kind`, message: `kind '${kind}' is not allowed by limits.kinds` });
      }
    }
  }

  const adj = adjacency(graph);
  if (limits.require_after) {
    for (const [predicate, role] of Object.entries(limits.require_after)) {
      if (role !== "reviewer") continue;
      const kinds = kindsFromPredicate(predicate);
      if (!kinds) {
        errors.push({ path: "limits.require_after", message: `unrecognized require_after predicate '${predicate}'` });
        continue;
      }
      for (const [id, step] of Object.entries(steps)) {
        const kind = agentKind(step);
        if (!kind || !kinds.has(kind)) continue;
        const after = reachableFrom(id, adj);
        after.delete(id);
        const hasReviewer = [...after].some(name => isReviewer(steps[name]));
        if (!hasReviewer) {
          errors.push({
            path: `steps.${id}`,
            message: `require_after: step '${id}' (kind ${kind}) has no following reviewer`,
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
      if (preds.every(id => agentKind(steps[id]) === required)) continue;
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

  return errors;
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

/**
 * Validate and store a generated graph for a waiting `generate` step.
 * Invalid graphs return every error; past `retries` the step fails.
 */
export function submitGraph(
  ctx: Ctx,
  input: { runId: string; stepId: string; source: WorkflowDef },
): SubmitGraphResult {
  const run = getRun(ctx, input.runId);
  if (!run) throw new CoreError("not_found", `unknown run ${input.runId}`);
  const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
  const stepDef = def?.steps[input.stepId];
  if (!stepDef || stepDef.type !== "generate") {
    throw new CoreError("conflict", `conflict: step ${input.stepId} is not a generate step`);
  }
  const row = latestWaitingGenerate(ctx, input.runId, input.stepId);
  if (!row) throw new CoreError("conflict", `conflict: step ${input.stepId} is not waiting for a graph`);

  const depth = nestingDepth(ctx, run.id);
  const errors = validateGenerated(input.source, stepDef.limits, depth);
  if (errors.length > 0) {
    const priorFails = typeof (row.result as { submitFails?: unknown } | undefined)?.submitFails === "number"
      ? (row.result as { submitFails: number }).submitFails
      : 0;
    const submitFails = priorFails + 1;
    const retries = stepDef.retries ?? 2;
    if (submitFails > retries) {
      updateStep(ctx, keyOf(row), {
        status: "failed",
        error: `generate validation failed after ${retries} retries`,
        endedAt: ctx.now,
        result: { submitFails, errors },
      });
    } else {
      updateStep(ctx, keyOf(row), { result: { submitFails, errors } });
    }
    return { ok: false, errors };
  }

  const stored = insertGraphVersion(ctx, {
    runId: run.id,
    stepId: input.stepId,
    attempt: row.attempt,
    def: input.source,
    status: "proposed",
  });
  updateStep(ctx, keyOf(row), {
    result: {
      graphVersion: stored.version,
      submitFails: 0,
    },
  });
  return { ok: true, errors: [], version: stored.version };
}

export type { GenerateStep, GenerateLimits };
