import { listLiveTasks, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { type Backend, backendById } from "./backend";

/** How long a kept-alive worker waits for an answer before pacer stops it and frees its slot. */
export const LIVE_IDLE_S = 4 * 60 * 60;

/**
 * Whether the backend should keep owning a task's live worker: its runner is supervising it, a managed restart is
 * pending, it waits on its unanswered question within the idle limit, or an answer attempt is about to reattach to it.
 */
export function liveWorkerOwned(task: TaskRecord, now: number, lookup: (id: string) => TaskRecord | null): boolean {
  if (!task.live) return false;
  if (task.state === "running" || task.state === "queued") return true;
  if (task.state !== "needs_input" || task.review || task.dismissed || task.resolved) return false;
  if (task.retriedBy) return ["queued", "running"].includes(lookup(task.retriedBy)?.state ?? "");
  return !!task.question && task.question.answer === undefined && now - task.live.since < LIVE_IDLE_S;
}

/** Stop a task's live worker through the backend that owns it; a backend without the capability just drops the record. */
export async function releaseLiveWorker(ctx: Ctx, task: TaskRecord, why: string, extras?: Backend[]): Promise<void> {
  const live = task.live;
  if (!live) return;
  const backend = backendById(live.backend, extras);
  if (backend?.live) await backend.live.release(ctx, task, why);
  else updateTask(ctx, task.id, t => { if (t.live?.worker === live.worker) delete t.live; });
}

/** Release every live worker its task no longer owns (stopped, settled, reviewed, retried elsewhere or idle too long). */
export async function reapLiveWorkers(ctx: Ctx, extras?: Backend[]): Promise<string[]> {
  const released: string[] = [];
  for (const task of listLiveTasks(ctx)) {
    if (liveWorkerOwned(task, ctx.now, id => readTask(ctx, id))) continue;
    const expired = task.state === "needs_input" && ctx.now - task.live!.since >= LIVE_IDLE_S;
    try {
      await releaseLiveWorker(ctx, task, expired ? "idle limit reached while waiting for an answer" : `task is ${task.state}`, extras);
      released.push(task.id);
    } catch { /* the next supervision pass retries */ }
  }
  return released;
}
