import { lstatSync } from "node:fs";
import { CoreError } from "../core/errors";
import { readTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";
import type { CallResources } from "./authority";
import { executorStopResult } from "./executor-protocol";
import { inspectOwnedExecutorRun } from "./executor-run-state";

interface ExecutorStopCaller {
  call(ctx: Ctx, pluginId: string, method: "executor.stop", params: unknown,
    options: { resources: CallResources; deadlineMs: number }): Promise<unknown>;
}

/** Stage a one-use stop for the exact persisted local detached run. */
export async function stopOwnedExecutorAttempt(ctx: Ctx, caller: ExecutorStopCaller, pluginId: string,
  taskId: string, attempt: number, graceMs: number): Promise<ReturnType<typeof executorStopResult.parse>> {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 25_000)
    throw new CoreError("invalid_input", "executor stop grace must be bounded");
  const state = inspectOwnedExecutorRun(ctx, taskId, attempt);
  if (state.state !== "running" || state.pid === null)
    throw new CoreError("conflict", "executor wrapper is not running");
  const grant = withTaskLock(ctx, taskId, () => {
    const task = readTask(ctx, taskId), current = lstatSync(state.dir);
    if (!task || task.rev !== state.task.rev || !task.run || task.run.dir !== state.dir ||
      task.run.attempt !== attempt || task.run.executor !== task.executor || !current.isDirectory())
      throw new CoreError("conflict", "executor stop owner changed before issuance");
    if (task.executorProvider && (task.executorProvider !== pluginId || !task.stopPending ||
      task.stopPending.providerId !== pluginId || task.stopPending.attempt !== attempt ||
      task.stopPending.graceMs !== graceMs))
      throw new CoreError("conflict", "executor stop is not pending for this provider and attempt");
    return { taskId, rev: task.rev, attempt, dir: state.dir,
      dirIdentity: { dev: current.dev, ino: current.ino }, pid: state.pid!,
      startedAt: task.run.startedAt, executor: task.run.executor, graceMs,
      ...(task.executorProvider && task.stopPending ? { stopIntent: {
        requestedAt: task.stopPending.requestedAt, providerId: task.stopPending.providerId,
      } } : {}) };
  });
  const raw = await caller.call(ctx, pluginId, "executor.stop", { taskId, attempt, graceMs }, {
    resources: { reads: [], commands: [], stores: [], detachedStop: grant }, deadlineMs: graceMs + 5_000,
  });
  const result = executorStopResult.safeParse(raw);
  if (!result.success) throw new CoreError("plugin_refused", "executor stop returned an invalid receipt");
  withTaskLock(ctx, taskId, () => {
    const after = inspectOwnedExecutorRun(ctx, taskId, attempt);
    const task = readTask(ctx, taskId), dir = lstatSync(grant.dir);
    if ((grant.stopIntent ? !task || task.executorProvider !== grant.stopIntent.providerId ||
        !task.stopPending || task.stopPending.providerId !== grant.stopIntent.providerId ||
        task.stopPending.requestedAt !== grant.stopIntent.requestedAt ||
        task.stopPending.attempt !== grant.attempt || task.stopPending.graceMs !== grant.graceMs
      : after.task.rev !== grant.rev) ||
      after.dir !== grant.dir || task?.run?.startedAt !== grant.startedAt ||
      dir.dev !== grant.dirIdentity.dev || dir.ino !== grant.dirIdentity.ino ||
      after.pid !== grant.pid || after.state !== "exited" || after.exitCode !== result.data.code)
      throw new CoreError("conflict", "executor stop receipt does not match the owned run");
  });
  return result.data;
}
