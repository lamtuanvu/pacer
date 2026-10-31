import { CoreError } from "../core/errors";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { executorRunEvent } from "./executor-protocol";

/** Apply one owner-bound executor observation; the caller captures the host-issued run before calling the plugin. */
export function applyExecutorProgress(ctx: Ctx, taskId: string, attempt: number, event: unknown,
  owner: Pick<RunRef, "dir" | "attempt" | "executor" | "startedAt">): TaskRecord {
  const parsed = executorRunEvent.safeParse(event);
  if (!parsed.success || parsed.data.kind !== "progress")
    throw new CoreError("invalid_input", "invalid executor progress event");
  const progressEvent = parsed.data;
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new CoreError("invalid_input", "invalid executor attempt");
  return withTaskLock(ctx, taskId, () => {
    const task = readTask(ctx, taskId);
    if (!task) throw new CoreError("unknown_task", `unknown task ${taskId}`);
    if (task.state !== "running") throw new CoreError("conflict", "task is not running");
    if (task.attempts.length + 1 !== attempt || owner.attempt !== attempt)
      throw new CoreError("conflict", "executor attempt changed");
    if (!task.run || task.run.host || task.run.attempt !== owner.attempt || task.run.dir !== owner.dir ||
      task.run.executor !== owner.executor || task.run.startedAt !== owner.startedAt)
      throw new CoreError("conflict", "active executor run changed");
    if (task.rev !== progressEvent.expectRev) throw new CoreError("conflict", "task changed");
    return updateTask(ctx, taskId, current => { current.progress = progressEvent.progress; });
  });
}
