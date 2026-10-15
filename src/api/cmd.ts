import { ApiError } from "./client";
import { CoreError } from "../core/errors";
import type { CmdData } from "../link/envelope";

export function cmdToOp(data: CmdData): { op: string; params: Record<string, unknown> } | null {
  switch (data.cmd) {
    case "stop": return { op: "task.stop", params: { id: data.taskId } };
    case "retry": return { op: "task.retry", params: { id: data.taskId, ...(data.executor !== undefined ? { executor: data.executor } : {}) } };
    case "dismiss": return { op: "task.dismiss", params: { ids: data.taskIds ?? (data.taskId ? [data.taskId] : []) } };
    case "block": return { op: "runner.block", params: {
      id: data.executor,
      ...(data.for !== undefined ? { for: data.for } : {}),
      ...("reason" in data && typeof data.reason === "string" ? { reason: data.reason } : {}),
    } };
    case "unblock": return { op: "runner.unblock", params: { id: data.executor } };
    case "use": return data.strategy ? { op: "strategy.use", params: { name: data.strategy } } : null;
    default: return null;
  }
}


export const CMD_SUCCESS: Record<string, (params: Record<string, unknown>, result: unknown) => string> = {
  "task.stop": (_params, result) => `${(result as { task_id: string }).task_id} stopped`,
  "task.retry": (_params, result) => {
    const r = result as { retry: { task_id: string }; of: { task_id: string } };
    return `${r.retry.task_id} queued (retry of ${r.of.task_id})`;
  },
  "task.dismiss": (_params, result) => {
    const r = result as { dismissed: string[]; unknown: string[] };
    return `dismissed ${r.dismissed.length}${r.unknown.length ? `; unknown: ${r.unknown.join(", ")}` : ""}`;
  },
  "runner.block": params => `blocked ${params.id}`,
  "runner.unblock": params => `unblocked ${params.id}`,
  "strategy.use": params => `active strategy: ${params.name}`,
};

export async function runMappedCmd(
  call: (op: string, params: unknown) => Promise<unknown>,
  data: CmdData,
): Promise<{ handled: false } | { handled: true; ok: boolean; message: string }> {
  const command = cmdToOp(data);
  if (!command) return { handled: false };
  try {
    const result = await call(command.op, command.params);
    return { handled: true, ok: true, message: CMD_SUCCESS[command.op](command.params, result) };
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof CoreError)) throw error;
    return { handled: true, ok: false, message: `pacer: ${error.message}${error.hint ? ` (${error.hint})` : ""}` };
  }
}
