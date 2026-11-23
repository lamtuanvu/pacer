// Engine-owned root work node per run (Phase 3): step tasks are dispatcher children
// of the root so capacity, fallback and liveness apply. The orchestrator task stays
// outside this tree (Phase 2 design).
//
// The engine already creates a successor only after its predecessor settles (`done`),
// so engine-created steps do NOT add dispatcher dependency edges. The root is used
// for parenting, limits and visibility only. Accept-before-dependents belongs to the
// run-branch design (Phase 5), not Phase 3 work-node chains.
import type { Ctx } from "../types";
import type { SpawnRunner, DelegateInput } from "../tasks/api";
import type { TaskRecord } from "../tasks/types";
import { TERMINAL_STATES } from "../tasks/types";
import { createTask, readTask, updateTask, taskDatabase } from "../tasks/store";
import { getWork, registerWork, type WorkOptions } from "../dispatch/work";
import { CoreError } from "../core/errors";
import {
  getDefinition,
  getRun,
  replaceRootTaskId,
  setRootTaskId,
  workflowDatabase,
  type RunRow,
} from "./store";
import type { WorkflowDef } from "./schema";
import { stepDispatchOptions } from "./priority";

/** Schema cap for work options.maxDescendants. */
const MAX_DESCENDANTS_CAP = 1000;
/** Schema cap for work options.maxConcurrent. */
const MAX_CONCURRENT_CAP = 64;

/**
 * Workflow roots use the schema maxDescendants cap. The engine already bounds
 * loops and steps; validateWorkflow still rejects uncapped estimates above 1000
 * as an early check, and estimateWorkUnits remains for generated-graph limits.
 */
export function rootCapacityFromGraph(_def: WorkflowDef | null): number {
  return MAX_DESCENDANTS_CAP;
}

/**
 * Root concurrency is the schema max. Local width is already bounded by
 * execution.local_max_tasks via slots (which also exclude workflow-root); tying
 * maxConcurrent to local_max_tasks double-throttled locals and capped remote/host
 * executors incorrectly. After reserveDispatch excludes the synthetic root, an
 * extra root throttle is redundant.
 */
export function rootMaxConcurrent(_ctx: Ctx): number {
  return MAX_CONCURRENT_CAP;
}

function rootIsUsable(ctx: Ctx, taskId: string): boolean {
  const task = readTask(ctx, taskId);
  if (!task || TERMINAL_STATES.includes(task.state)) return false;
  return !!getWork(ctx, taskId);
}

function findWfrootTask(ctx: Ctx, runId: string): TaskRecord | undefined {
  const requestId = `wfroot:${runId}`;
  // Prefer a live row; fall back to any matching request id (revive path).
  const row = taskDatabase(ctx).query<{ id: string }, [string]>(
    `SELECT id FROM tasks
     WHERE json_extract(record, '$.kind') = 'workflow-root'
       AND json_extract(record, '$.requestId') = ?
     ORDER BY CASE WHEN state IN ('queued', 'running') THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`,
  ).get(requestId);
  return row ? readTask(ctx, row.id) ?? undefined : undefined;
}

/** Register (or reuse) one engine-owned root work node for the run. */
export function ensureRootWorkNode(ctx: Ctx, run: RunRow): string {
  const live = getRun(ctx, run.id) ?? run;
  if (live.rootTaskId && rootIsUsable(ctx, live.rootTaskId)) return live.rootTaskId;

  const maxConcurrent = rootMaxConcurrent(ctx);

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
        maxConcurrent,
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
      maxConcurrent,
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
 * Selective: only queued/running workflow-root rows with wfroot: request ids —
 * never a full task/history scan.
 */
export function reconcileOrphanWorkflowRoots(ctx: Ctx): string[] {
  const liveRoots = new Set(
    workflowDatabase(ctx).query<{ root_task_id: string | null }, []>(
      "SELECT root_task_id FROM workflow_runs WHERE root_task_id IS NOT NULL",
    ).all().map(r => r.root_task_id).filter((id): id is string => typeof id === "string"),
  );
  const candidates = taskDatabase(ctx).query<{ id: string }, []>(
    `SELECT id FROM tasks
     WHERE state IN ('queued', 'running')
       AND json_extract(record, '$.kind') = 'workflow-root'
       AND json_extract(record, '$.requestId') LIKE 'wfroot:%'`,
  ).all();
  const swept: string[] = [];
  for (const { id } of candidates) {
    if (liveRoots.has(id)) continue;
    const task = readTask(ctx, id);
    if (!task || TERMINAL_STATES.includes(task.state)) continue;
    if (task.kind !== "workflow-root") continue;
    if (!task.requestId?.startsWith("wfroot:")) continue;
    try {
      updateTask(ctx, id, t => {
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
      swept.push(id);
    } catch { /* */ }
  }
  return swept;
}

export interface StartStepTaskInput {
  brief: DelegateInput["brief"];
  kind?: string;
  difficulty?: DelegateInput["difficulty"];
  title: string;
  requestId: string;
  /** Mapped run priority for the work node (Phase 6). */
  priority?: number;
  worktree?: DelegateInput["worktree"];
  worktree_reason?: DelegateInput["worktree_reason"];
}

type DelegateFn = (ctx: Ctx, input: DelegateInput, spawn?: SpawnRunner) => Promise<TaskRecord>;

/**
 * Delegate a step task as a child of the run's root work node. Engine-created
 * steps do not attach dispatcher dependency edges (the engine already waits for
 * the predecessor to settle before creating this step).
 */
export async function startStepTask(
  ctx: Ctx,
  run: RunRow,
  input: StartStepTaskInput,
  delegate: DelegateFn,
  spawn?: SpawnRunner,
): Promise<TaskRecord> {
  const rootId = ensureRootWorkNode(ctx, getRun(ctx, run.id) ?? run);
  if (readTask(ctx, rootId)?.state !== "running") {
    updateTask(ctx, rootId, t => { t.state = "running"; });
  }
  // Errors from registerWork (capacity, parent closed, …) must fail the step.
  const dispatch = input.priority !== undefined
    ? stepDispatchOptions(input.priority, true)
    : undefined;
  return delegate(ctx, {
    brief: input.brief,
    kind: input.kind,
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    title: input.title,
    requestId: input.requestId,
    workParent: rootId,
    ...(dispatch ? { dispatch } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.worktree_reason ? { worktree_reason: input.worktree_reason } : {}),
  }, spawn);
}

export function isWorkNodeRun(run: RunRow): boolean {
  return run.stepMode === "work_node";
}
