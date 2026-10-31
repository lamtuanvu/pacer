import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";
import type { CallResources } from "./authority";
import { executorSessionStateResult } from "./executor-protocol";
import { inspectOwnedExecutorRun } from "./executor-run-state";

interface ExecutorSessionCaller {
  call(ctx: Ctx, pluginId: string, method: "executor.sessionState", params: unknown,
    options: { resources: CallResources; deadlineMs: number }): Promise<unknown>;
}

/** Issue an exact read grant, then verify the provider's state against durable state. */
export async function inspectOwnedExecutorSession(ctx: Ctx, caller: ExecutorSessionCaller,
  pluginId: string, taskId: string, attempt: number): Promise<ReturnType<typeof executorSessionStateResult.parse>> {
  const grant = withTaskLock(ctx, taskId, () => {
    if (!/^t-[A-Za-z0-9_-]{1,120}$/.test(taskId) || !Number.isSafeInteger(attempt) || attempt < 1)
      throw new CoreError("invalid_input", "invalid executor run identity");
    const path = join(ctx.pacerHome, "runs", taskId, String(attempt));
    let before;
    try { before = lstatSync(path); }
    catch { throw new CoreError("conflict", "executor session directory is unavailable"); }
    const state = inspectOwnedExecutorRun(ctx, taskId, attempt);
    const task = readTask(ctx, taskId), dir = lstatSync(state.dir);
    if (!task || task.rev !== state.task.rev || !task.run || !dir.isDirectory() ||
      before.dev !== dir.dev || before.ino !== dir.ino)
      throw new CoreError("conflict", "executor session owner changed before issuance");
    return { taskId, rev: task.rev, attempt, dir: state.dir,
      dirIdentity: { dev: dir.dev, ino: dir.ino },
      startedAt: task.run.startedAt, executor: task.run.executor };
  });
  const raw = await caller.call(ctx, pluginId, "executor.sessionState", { taskId, attempt }, {
    resources: { reads: [], commands: [], stores: [], detachedInspect: grant }, deadlineMs: 5_000,
  });
  const result = executorSessionStateResult.safeParse(raw);
  if (!result.success) throw new CoreError("plugin_refused", "executor session state returned an invalid receipt");
  const current = inspectOwnedExecutorRun(ctx, taskId, attempt);
  if (current.task.rev !== grant.rev || current.dir !== grant.dir ||
    result.data.state !== current.state)
    throw new CoreError("conflict", "executor session state receipt is stale");
  return result.data;
}
