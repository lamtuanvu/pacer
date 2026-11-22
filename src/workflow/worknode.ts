// Engine-owned root work node per run (Phase 3): step tasks are dispatcher children
// of the root so dependencies, capacity, fallback and liveness apply. The
// orchestrator task stays outside this tree (Phase 2 design).
//
// Dependency semantics (workflow roots): the engine advances the graph on step
// `done` (creates the next step task under the root). Dispatcher dependency edges
// clear only when the predecessor is `review.accepted` (or waived), matching the
// design spec's accept-before-dependents-run rule. A successor therefore stays
// queued until accept even though its step row already exists.
import type { Ctx } from "../types";
import type { SpawnRunner, DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { TERMINAL_STATES } from "../tasks/types";
import { createTask, listTasksWhere, readTask, updateTask } from "../tasks/store";
import { getWork, registerWork, type WorkOptions } from "../dispatch/work";
import { CoreError } from "../core/errors";
import {
  getDefinition,
  getRun,
  listRuns,
  replaceRootTaskId,
  setRootTaskId,
  stepsOfRun,
  type RunRow,
} from "./store";
import type { FanoutStep, GenerateStep, WorkflowDef } from "./schema";

/** Descendant budget from the concrete graph (not generate.limits.max_steps). */
export function rootCapacityFromGraph(def: WorkflowDef | null): number {
  if (!def) return 20;
  let n = 0;
  for (const step of Object.values(def.steps)) {
    if (!step || step.type === "end") continue;
    if (step.type === "fanout") {
      const fan = step as FanoutStep;
      n += Math.max(1, fan.branches.length);
    } else if (step.type === "generate") {
      // One waiting generate step under this root; the child run has its own root.
      n += 1;
      void (step as GenerateStep);
    } else {
      n += 1;
    }
  }
  let loops = 0;
  for (const edge of def.edges) {
    if (typeof edge.maxLoops === "number") loops += edge.maxLoops;
  }
  return Math.max(20, n + loops);
}

function rootIsUsable(ctx: Ctx, taskId: string): boolean {
  const task = readTask(ctx, taskId);
  if (!task || TERMINAL_STATES.includes(task.state)) return false;
  return !!getWork(ctx, taskId);
}

function findWfrootTask(ctx: Ctx, runId: string): TaskRecord | undefined {
  const requestId = `wfroot:${runId}`;
  return listTasksWhere(ctx, { all: true }).find(t => t.requestId === requestId && t.kind === "workflow-root");
}

/** Register (or reuse) one engine-owned root work node for the run. */
export function ensureRootWorkNode(ctx: Ctx, run: RunRow): string {
  const live = getRun(ctx, run.id) ?? run;
  if (live.rootTaskId && rootIsUsable(ctx, live.rootTaskId)) return live.rootTaskId;

  // Reuse an existing wfroot:<run> task when the stamped id is missing/dead.
  const reused = findWfrootTask(ctx, live.id);
  if (reused && rootIsUsable(ctx, reused.id)) {
    if (readTask(ctx, reused.id)?.state !== "running") {
      updateTask(ctx, reused.id, t => { t.state = "running"; });
    }
    if (!getWork(ctx, reused.id)) {
      const def = getDefinition(ctx, `${live.workflow}@${live.version}`) ?? getDefinition(ctx, live.workflow);
      registerWork(ctx, reused.id, {
        allowDelegation: true,
        delegationEnforcement: "strict",
        kind: "workflow-root",
        maxDescendants: rootCapacityFromGraph(def),
        maxConcurrent: 4,
      } satisfies Partial<WorkOptions>);
    }
    if (live.rootTaskId && live.rootTaskId !== reused.id) {
      replaceRootTaskId(ctx, live.id, live.rootTaskId, reused.id);
    } else if (!live.rootTaskId) {
      setRootTaskId(ctx, live.id, reused.id);
    }
    return getRun(ctx, live.id)?.rootTaskId ?? reused.id;
  }

  const def = getDefinition(ctx, `${live.workflow}@${live.version}`) ?? getDefinition(ctx, live.workflow);
  const maxDescendants = rootCapacityFromGraph(def);
  const task = reused && !rootIsUsable(ctx, reused.id)
    ? (() => {
      // Revive a terminal wfroot row in place (same request id) when possible.
      updateTask(ctx, reused.id, t => {
        t.state = "running";
        t.kind = "workflow-root";
        delete t.result;
        delete t.queue;
      });
      return readTask(ctx, reused.id)!;
    })()
    : createTask(ctx, {
      brief: { goal: `workflow-root ${live.id}`, repo: live.repo },
      kind: "workflow-root",
      requestedExecutor: null,
      timeoutS: 24 * 60 * 60,
      title: `workflow-root ${live.id}`.slice(0, 60),
      requestId: `wfroot:${live.id}`,
    });
  if (readTask(ctx, task.id)?.state !== "running") {
    updateTask(ctx, task.id, t => { t.state = "running"; });
  }
  if (!getWork(ctx, task.id)) {
    registerWork(ctx, task.id, {
      allowDelegation: true,
      delegationEnforcement: "strict",
      kind: "workflow-root",
      maxDescendants,
      maxConcurrent: 4,
    } satisfies Partial<WorkOptions>);
  }
  const afterCreate = getRun(ctx, live.id) ?? live;
  if (afterCreate.rootTaskId && afterCreate.rootTaskId !== task.id) {
    try {
      replaceRootTaskId(ctx, afterCreate.id, afterCreate.rootTaskId, task.id);
    } catch {
      const after = getRun(ctx, afterCreate.id);
      if (after?.rootTaskId && rootIsUsable(ctx, after.rootTaskId)) {
        try { updateTask(ctx, task.id, t => { t.state = "stopped"; }); } catch { /* */ }
        return after.rootTaskId;
      }
      throw new CoreError("conflict", `conflict: run ${afterCreate.id} could not replace dead root`);
    }
  } else {
    try {
      setRootTaskId(ctx, afterCreate.id, task.id);
    } catch {
      const after = getRun(ctx, afterCreate.id);
      if (after?.rootTaskId && after.rootTaskId !== task.id && rootIsUsable(ctx, after.rootTaskId)) {
        try { updateTask(ctx, task.id, t => { t.state = "stopped"; }); } catch { /* */ }
        return after.rootTaskId;
      }
    }
  }
  return getRun(ctx, live.id)?.rootTaskId ?? task.id;
}

/**
 * Stop running workflow-root tasks whose `wfroot:<run>` request id no longer
 * matches a live run's root_task_id (crash/leak recovery).
 */
export function reconcileOrphanWorkflowRoots(ctx: Ctx): string[] {
  const liveRoots = new Set(
    listRuns(ctx).map(r => r.rootTaskId).filter((id): id is string => typeof id === "string"),
  );
  const swept: string[] = [];
  for (const task of listTasksWhere(ctx, { all: true })) {
    if (task.kind !== "workflow-root") continue;
    if (!task.requestId?.startsWith("wfroot:")) continue;
    if (liveRoots.has(task.id)) continue;
    if (TERMINAL_STATES.includes(task.state)) continue;
    try {
      updateTask(ctx, task.id, t => {
        t.state = "stopped";
        t.result = {
          status: "stopped",
          executor: null,
          model: null,
          files: "",
          report: "orphan workflow-root reconciled",
          backend: "direct",
        };
        delete t.queue;
      });
      swept.push(task.id);
    } catch { /* */ }
  }
  return swept;
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
 * predecessor tasks as dispatcher dependency edges. workParent/dependencies are
 * passed through the real delegate so registration happens before launch.
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
  ].filter(id => id && getWork(ctx, id));
  // Errors from registerWork (capacity, parent closed, …) must fail the step.
  return delegate(ctx, {
    brief: input.brief,
    kind: input.kind,
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    title: input.title,
    requestId: input.requestId,
    workParent: rootId,
    ...(deps.length > 0 ? { dependencies: deps } : {}),
  }, spawn);
}

export function isWorkNodeRun(run: RunRow): boolean {
  return run.stepMode === "work_node";
}
