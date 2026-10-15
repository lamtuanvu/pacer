import type { Strategy } from "../config/strategy";
import {
  type DelegateInput, type SpawnRunner, delegate as apiDelegate, spawnRunner, taskDismiss, taskReview, taskStatus,
  taskStop, taskWait,
} from "../tasks/api";
import { listTasks, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { CoreError, toCoreError } from "./errors";
import { withLock } from "./lock";

export const WAIT_MIN_S = 1;
export const WAIT_MAX_S = 3000;

const unknown = (id: string) => new CoreError("unknown_task", `unknown task ${id}`);

export function get(ctx: Ctx, id: string): TaskRecord {
  const t = taskStatus(ctx, id);
  if (!t) throw unknown(id);
  return t;
}

/** Newest first; each task's liveness is re-checked like `get`. */
export function list(ctx: Ctx, o: { limit?: number } = {}): TaskRecord[] {
  return listTasks(ctx, o.limit ?? 20).map((t) => taskStatus(ctx, t.id) ?? t);
}

export function delegate(ctx: Ctx, input: DelegateInput, spawn: SpawnRunner = spawnRunner, s?: Strategy): TaskRecord {
  try {
    return s ? apiDelegate(ctx, input, spawn, s) : apiDelegate(ctx, input, spawn);
  } catch (e) {
    throw toCoreError(e);
  }
}

export async function wait(ctx: Ctx, id: string, timeoutS: number): Promise<TaskRecord> {
  if (!Number.isInteger(timeoutS) || timeoutS < WAIT_MIN_S || timeoutS > WAIT_MAX_S) {
    throw new CoreError("invalid_input", `timeout must be between ${WAIT_MIN_S} and ${WAIT_MAX_S} seconds`);
  }
  const t = await taskWait(ctx, id, timeoutS);
  if (!t) throw unknown(id);
  return t;
}

export function stop(ctx: Ctx, id: string): TaskRecord {
  const t = taskStop(ctx, id);
  if (!t) throw unknown(id);
  return t;
}

export function review(ctx: Ctx, id: string, v: { accepted: boolean; kind?: string; note?: string }): { recorded: true } {
  try {
    return taskReview(ctx, id, v.accepted, v.kind, v.note);
  } catch (e) {
    throw toCoreError(e);
  }
}

/** Dismisses every known id; unknown ids are returned, never thrown, so one bad id can't stop the rest. */
export function dismiss(ctx: Ctx, ids: string[]): { dismissed: TaskRecord[]; unknown: string[] } {
  const dismissed: TaskRecord[] = [], missing: string[] = [];
  for (const id of ids) {
    const t = taskDismiss(ctx, id);
    if (t) dismissed.push(t); else missing.push(id);
  }
  return { dismissed, unknown: missing };
}

/** Re-delegates a task's stored brief. One active retry per task: a second call gets `conflict`. */
export async function retry(
  ctx: Ctx, id: string, o: { executor?: string; fromPanel?: boolean } = {},
  deps: { delegate?: (ctx: Ctx, input: DelegateInput) => TaskRecord } = {},
): Promise<{ retry: TaskRecord; of: TaskRecord }> {
  return withLock(ctx, `retry-${id}`, async () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    const prior = task.retriedBy ? readTask(ctx, task.retriedBy) : null;
    if (prior && ["queued", "running"].includes(prior.state)) {
      throw new CoreError("conflict", `${task.id} already has an active retry ${prior.id}`);
    }
    const input: DelegateInput = {
      brief: { ...task.brief }, kind: task.kind, timeoutMin: task.timeoutS / 60, retryOf: task.id,
      ...(o.executor ? { executor: o.executor } : {}),
    };
    let next: TaskRecord;
    try {
      next = (deps.delegate ?? ((c, i) => apiDelegate(c, i)))(ctx, input);
    } catch (e) {
      throw toCoreError(e);
    }
    if (readTask(ctx, next.id)) updateTask(ctx, next.id, (t) => { t.retryOf = task.id; if (o.fromPanel) t.fromPanel = true; });
    const of = updateTask(ctx, task.id, (t) => { t.retriedBy = next.id; });
    return { retry: readTask(ctx, next.id) ?? next, of };
  });
}
