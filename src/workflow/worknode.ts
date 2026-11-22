// Engine-owned root work node per run (Phase 3): step tasks are dispatcher children
// of the root so dependencies, capacity, fallback and liveness apply. The
// orchestrator task stays outside this tree (Phase 2 design).
import type { Ctx } from "../types";
import type { SpawnRunner, DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { createTask, readTask, updateTask } from "../tasks/store";
import { getWork, registerWork, setWorkDependencies, type WorkOptions } from "../dispatch/work";
import { CoreError } from "../core/errors";
import {
  getDefinition,
  getRun,
  setRootTaskId,
  stepsOfRun,
  type RunRow,
} from "./store";
import type { GenerateStep, WorkflowDef } from "./schema";

function maxStepsFromDef(def: WorkflowDef | null): number {
  if (!def) return 0;
  let max = 0;
  for (const step of Object.values(def.steps)) {
    if (step?.type === "generate") {
      const gen = step as GenerateStep;
      if (typeof gen.limits?.max_steps === "number") max = Math.max(max, gen.limits.max_steps);
    }
  }
  return max;
}

/** Register (or reuse) one engine-owned root work node for the run. */
export function ensureRootWorkNode(ctx: Ctx, run: RunRow): string {
  if (run.rootTaskId) {
    const existing = readTask(ctx, run.rootTaskId);
    if (existing && getWork(ctx, run.rootTaskId)) return run.rootTaskId;
  }
  const def = getDefinition(ctx, `${run.workflow}@${run.version}`) ?? getDefinition(ctx, run.workflow);
  const generatedMax = maxStepsFromDef(def);
  const maxDescendants = Math.max(20, generatedMax + 10);
  const task = createTask(ctx, {
    brief: { goal: `workflow-root ${run.id}`, repo: run.repo },
    kind: "workflow-root",
    requestedExecutor: null,
    timeoutS: 24 * 60 * 60,
    title: `workflow-root ${run.id}`.slice(0, 60),
    requestId: `wfroot:${run.id}`,
  });
  // Root must stay running so children can register under it.
  updateTask(ctx, task.id, t => { t.state = "running"; });
  registerWork(ctx, task.id, {
    allowDelegation: true,
    delegationEnforcement: "strict",
    kind: "workflow-root",
    maxDescendants,
    maxConcurrent: 4,
  } satisfies Partial<WorkOptions>);
  try {
    setRootTaskId(ctx, run.id, task.id);
  } catch {
    const after = getRun(ctx, run.id);
    if (after?.rootTaskId && after.rootTaskId !== task.id) {
      try { updateTask(ctx, task.id, t => { t.state = "stopped"; }); } catch { /* */ }
      return after.rootTaskId;
    }
  }
  return getRun(ctx, run.id)?.rootTaskId ?? task.id;
}

/** Predecessor step task ids for dispatcher dependency edges (same run). */
export function predecessorTaskIds(ctx: Ctx, run: RunRow, stepId: string, def: WorkflowDef): string[] {
  const preds = def.edges.filter(e => e.to === stepId).map(e => e.from);
  const ids: string[] = [];
  for (const pred of preds) {
    const rows = stepsOfRun(ctx, run.id).filter(s => s.stepId === pred && s.taskId);
    const row = [...rows].reverse().find(s => s.taskId) ?? rows[rows.length - 1];
    if (row?.taskId) ids.push(row.taskId);
  }
  return [...new Set(ids)];
}

export interface StartStepTaskInput {
  brief: DelegateInput["brief"];
  kind?: string;
  difficulty?: DelegateInput["difficulty"];
  title: string;
  requestId: string;
  dependencies?: string[];
}

type DelegateFn = (ctx: Ctx, input: DelegateInput, spawn?: SpawnRunner) => Promise<TaskRecord>;

/**
 * Delegate a step task as a child of the run's root work node, with the graph's
 * predecessor tasks as dispatcher dependency edges.
 */
export async function startStepTask(
  ctx: Ctx,
  run: RunRow,
  step: { stepId: string; branch?: string },
  input: StartStepTaskInput,
  delegate: DelegateFn,
  spawn?: SpawnRunner,
): Promise<TaskRecord> {
  const rootId = ensureRootWorkNode(ctx, getRun(ctx, run.id) ?? run);
  const fresh = getRun(ctx, run.id) ?? run;
  if (readTask(ctx, rootId)?.state !== "running") {
    updateTask(ctx, rootId, t => { t.state = "running"; });
  }
  const def = getDefinition(ctx, `${fresh.workflow}@${fresh.version}`) ?? getDefinition(ctx, fresh.workflow);
  if (!def) throw new CoreError("not_found", `unknown workflow for run ${fresh.id}`);
  const deps = [
    ...predecessorTaskIds(ctx, fresh, step.stepId, def),
    ...(input.dependencies ?? []),
  ];
  const task = await delegate(ctx, {
    brief: input.brief,
    kind: input.kind,
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    title: input.title,
    requestId: input.requestId,
    workParent: rootId,
  }, spawn);
  if (deps.length > 0 && getWork(ctx, task.id)) {
    try {
      setWorkDependencies(ctx, task.id, deps, readTask(ctx, task.id)!.rev);
    } catch {
      /* dependency may already be set or race */
    }
  }
  return task;
}

export function isWorkNodeRun(run: RunRow): boolean {
  return run.stepMode === "work_node";
}
