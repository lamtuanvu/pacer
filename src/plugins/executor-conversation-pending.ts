import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import { executorConversationRunning } from "./executor-protocol";
import { inspectOwnedExecutorRun } from "./executor-run-state";

/** Validate a finite provider observation against private persisted authority before another read-only poll. */
export function validateOwnedConversationPending(ctx: Ctx, providerId: string,
  taskId: string, attempt: number, raw: unknown): void {
  const parsed = executorConversationRunning.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "executor returned an invalid conversation observation");
  const result = parsed.data, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || task.state !== "running" || task.stopPending ||
    task.interactionMode !== "conversation" || task.executorProvider !== providerId ||
    run.interactionMode !== "conversation" || run.session !== "interactive" || run.host ||
    run.executor !== task.executor || run.attempt !== attempt ||
    result.taskId !== taskId || result.attempt !== attempt || result.startedAt !== run.startedAt ||
    task.startIntent?.attempt !== attempt || task.startIntent.providerId !== providerId ||
    task.startIntent.dir !== run.dir ||
    !run.agentSession?.id || task.conversation?.agentSessionId !== run.agentSession.id)
    throw new CoreError("conflict", "executor conversation observation changed owner");
  const observed = inspectOwnedExecutorRun(ctx, taskId, attempt);
  if (observed.dir !== run.dir || observed.startedAt !== run.startedAt || observed.state === "uncertain")
    throw new CoreError("conflict", "executor conversation observation has no verified run");
}
