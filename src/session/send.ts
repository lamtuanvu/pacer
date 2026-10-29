import { taskActivity } from "../core/tasks";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { isExecutorSession } from "../install/role";
import { OrcaClient } from "../exec/orca/client";
import { loadOrcaState } from "../exec/orca/state";
import { isTaskId, readTask, updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

const unknown = (id: string) => new CoreError("unknown_task", `unknown task ${id}`);

/**
 * How recently someone else must have sent for `pacer send` to refuse without `--force`. pacer has
 * no way to see a human typing directly in Orca's own terminal UI (see the interactive-lanes design
 * doc); this is a cooperative lease between pacer's own callers, not a process-level lock.
 */
export const DRIVING_LEASE_S = 60;

export interface SendOptions { force?: boolean; by?: string }

/** Deliver one message into a running interactive lane's live Orca terminal. Records it on the task's timeline; does not create a new attempt. */
export async function send(ctx: Ctx, id: string, text: string, o: SendOptions = {}): Promise<TaskRecord> {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", "executors cannot use pacer send; use pacer ask");
  if (!isTaskId(id)) throw unknown(id);
  if (typeof text !== "string" || !text.trim() || text.length > 4000) {
    throw new CoreError("invalid_input", "message must contain 1–4000 characters");
  }
  const by = o.by?.trim() || "planner";
  return withLock(ctx, `send-${id}`, async () => {
    const task = readTask(ctx, id);
    if (!task) throw unknown(id);
    if (!["running", "needs_input"].includes(task.state)) {
      throw new CoreError("conflict", `task is ${task.state}, not running`);
    }
    const worker = Object.values(loadOrcaState(ctx).workers).find(w => w.taskId === id);
    if (!worker?.terminal) throw new CoreError("not_allowed", "this task has no live Orca terminal to send into");
    const holder = task.driving;
    const contended = !!holder && holder.by !== by && ctx.now - holder.at < DRIVING_LEASE_S;
    if (contended && !o.force) {
      throw new CoreError("conflict", `${holder!.by} sent a message ${Math.round(ctx.now - holder!.at)}s ago; use --force to send anyway`);
    }
    const client = new OrcaClient(ctx.run, ctx.env);
    const sent = await client.terminalSend(worker.terminal, text);
    if (!sent.ok) throw new CoreError("unavailable", `orca terminal send failed: ${sent.error.code} ${sent.error.message}`);
    const updated = updateTask(ctx, id, t => { t.driving = { by, at: ctx.now }; });
    taskActivity(ctx, updated, "message", `Sent${contended ? ` (took over from ${holder!.by})` : ""}: ${text.slice(0, 200)}`);
    return updated;
  });
}
