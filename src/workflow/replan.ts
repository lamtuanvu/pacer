// Re-plan policy for generated child runs (Phase 3): keep finished steps, diff
// summaries, and auto-vs-ask wake-ups when a child step fails after fallback.
import type { Ctx } from "../types";
import {
  getDefinition,
  getRun,
  rootRunId,
  stepsOfRun,
  updateStep,
  type StepKey,
  type StepRow,
} from "./store";
import type { ReplanPolicy, WorkflowDef, WorkflowError } from "./schema";
import { enqueueWakeup, stepWakeRef } from "./wakeups";

export interface GraphDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ReplanNote {
  mode: "auto" | "ask";
  autosUsed: number;
  maxAuto: number;
  summary: {
    failedStep: string;
    added: string[];
    removed: string[];
    changed: string[];
  };
}

function keyOf(s: StepRow): StepKey {
  return { runId: s.runId, stepId: s.stepId, attempt: s.attempt, ...(s.branch !== undefined ? { branch: s.branch } : {}) };
}

function resultObj(row: StepRow | undefined): Record<string, unknown> {
  if (!row?.result || typeof row.result !== "object" || Array.isArray(row.result)) return {};
  return { ...(row.result as Record<string, unknown>) };
}

/** Stable JSON for comparing step definitions (order-insensitive enough for equality). */
function stepFingerprint(step: unknown): string {
  return JSON.stringify(step ?? null);
}

export function graphDiff(previous: WorkflowDef, next: WorkflowDef): GraphDiff {
  const prevIds = new Set(Object.keys(previous.steps));
  const nextIds = new Set(Object.keys(next.steps));
  const added = [...nextIds].filter(id => !prevIds.has(id)).sort();
  const removed = [...prevIds].filter(id => !nextIds.has(id)).sort();
  const changed = [...prevIds].filter(id =>
    nextIds.has(id) && stepFingerprint(previous.steps[id]) !== stepFingerprint(next.steps[id]),
  ).sort();
  return { added, removed, changed };
}

/**
 * Finished step ids must appear in the next graph with an identical definition.
 * Unfinished steps may be rewritten freely.
 */
export function validateReplanKeepFinished(
  previous: WorkflowDef,
  next: WorkflowDef,
  finishedIds: Iterable<string>,
): WorkflowError[] {
  const errors: WorkflowError[] = [];
  for (const id of finishedIds) {
    if (id === undefined) continue;
    const prev = previous.steps[id];
    if (!prev) continue;
    const nextStep = next.steps[id];
    if (!nextStep) {
      errors.push({ path: `steps.${id}`, message: `finished step '${id}' must be kept unchanged` });
      continue;
    }
    if (stepFingerprint(prev) !== stepFingerprint(nextStep)) {
      errors.push({ path: `steps.${id}`, message: `finished step '${id}' must be kept unchanged` });
    }
  }
  return errors;
}

export function replanPolicyOf(def: WorkflowDef | null | undefined): ReplanPolicy | undefined {
  return def?.policy?.replan;
}

function maxAuto(policy: ReplanPolicy): number {
  return policy === "ask" ? 0 : policy.auto;
}

/** Done step ids on a child run (excluding end). */
export function finishedStepIds(ctx: Ctx, childRunId: string): string[] {
  const ids: string[] = [];
  for (const row of stepsOfRun(ctx, childRunId)) {
    if (row.status !== "done") continue;
    if (row.branch !== undefined) continue; // fanout branches; join row is branch-less
    ids.push(row.stepId);
  }
  return [...new Set(ids)];
}

function parentGenerateRow(ctx: Ctx, childRunId: string): { parentId: string; row: StepRow; policy: ReplanPolicy } | null {
  const child = getRun(ctx, childRunId);
  if (!child?.parentRunId || !child.parentStep) return null;
  const parent = getRun(ctx, child.parentRunId);
  if (!parent) return null;
  const def = getDefinition(ctx, `${parent.workflow}@${parent.version}`) ?? getDefinition(ctx, parent.workflow);
  const stepDef = def?.steps[child.parentStep];
  if (!stepDef || stepDef.type !== "generate") return null;
  const policy = replanPolicyOf(def);
  if (!policy) return null;
  const waiting = stepsOfRun(ctx, parent.id).filter(s => s.stepId === child.parentStep && s.status === "waiting");
  const row = waiting[waiting.length - 1];
  if (!row) return null;
  return { parentId: parent.id, row, policy };
}

/** Last recorded replan mode for a generate step, or the mode the next failure would take. */
export function replanMode(ctx: Ctx, parentRunId: string, stepId: string): "auto" | "ask" | null {
  const parent = getRun(ctx, parentRunId);
  if (!parent) return null;
  const def = getDefinition(ctx, `${parent.workflow}@${parent.version}`) ?? getDefinition(ctx, parent.workflow);
  const policy = replanPolicyOf(def);
  if (!policy) return null;
  const row = stepsOfRun(ctx, parentRunId).filter(s => s.stepId === stepId).at(-1);
  const prior = resultObj(row);
  if (prior.replanMode === "auto" || prior.replanMode === "ask") return prior.replanMode;
  if (policy === "ask") return "ask";
  const used = typeof prior.replanAutosUsed === "number" ? prior.replanAutosUsed : 0;
  return used < policy.auto ? "auto" : "ask";
}

/**
 * Record a generated-child step failure for replan: increment auto usage when
 * still inside auto:N, enqueue a replan wake-up, and return the mode + empty
 * diff summary (the person/orchestrator fills the next graph).
 */
export function noteChildStepFailureForReplan(
  ctx: Ctx,
  childRunId: string,
  failedStep: string,
): ReplanNote | null {
  const found = parentGenerateRow(ctx, childRunId);
  if (!found) return null;
  const { parentId, row, policy } = found;
  const prior = resultObj(row);
  const used = typeof prior.replanAutosUsed === "number" ? prior.replanAutosUsed : 0;
  const max = maxAuto(policy);
  let mode: "auto" | "ask";
  let autosUsed = used;
  if (policy === "ask") {
    mode = "ask";
  } else if (used < policy.auto) {
    mode = "auto";
    autosUsed = used + 1;
  } else {
    mode = "ask";
  }
  const finished = finishedStepIds(ctx, childRunId);
  updateStep(ctx, keyOf(row), {
    result: {
      ...prior,
      replanAutosUsed: autosUsed,
      replanMode: mode,
      replanFinished: finished,
      replanFailedStep: failedStep,
      pendingApproval: mode === "ask" ? true : prior.pendingApproval,
    },
  });
  const root = rootRunId(ctx, parentId);
  enqueueWakeup(ctx, {
    runId: root,
    cause: "replan",
    ref: stepWakeRef(parentId, row.stepId, row.attempt),
    createdAt: ctx.now,
    ...(mode === "ask" ? { byPerson: true } : {}),
  });
  return {
    mode,
    autosUsed,
    maxAuto: max,
    summary: {
      failedStep,
      added: [],
      removed: [],
      changed: [],
    },
  };
}

/** Diff summary text for an approve_revise replan question. */
export function formatReplanSummary(diff: GraphDiff, failedStep: string): string {
  const parts = [`Failed step: ${failedStep}`];
  if (diff.added.length) parts.push(`Added: ${diff.added.join(", ")}`);
  if (diff.removed.length) parts.push(`Removed: ${diff.removed.join(", ")}`);
  if (diff.changed.length) parts.push(`Changed: ${diff.changed.join(", ")}`);
  if (parts.length === 1) parts.push("No structural change yet.");
  return parts.join(". ");
}
