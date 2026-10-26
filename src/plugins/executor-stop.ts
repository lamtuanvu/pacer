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
    return { taskId, rev: task.rev, attempt, dir: state.dir,
      dirIdentity: { dev: current.dev, ino: current.ino }, pid: state.pid!,
      startedAt: task.run.startedAt, executor: task.run.executor, graceMs };
  });
  const raw = await caller.call(ctx, pluginId, "executor.stop", { taskId, attempt, graceMs }, {
    resources: { reads: [], commands: [], stores: [], detachedStop: grant }, deadlineMs: graceMs + 5_000,
  });
  const result = executorStopResult.safeParse(raw);
  if (!result.success) throw new CoreError("plugin_refused", "executor stop returned an invalid receipt");
  const after = inspectOwnedExecutorRun(ctx, taskId, attempt);
  if (after.task.rev !== grant.rev || after.pid !== grant.pid || after.state !== "exited" ||
    after.exitCode !== result.data.code)
    throw new CoreError("conflict", "executor stop receipt does not match the owned run");
  return result.data;
}
