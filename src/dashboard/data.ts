import { ApiError, type ApiClient } from "../api/client";
import type { CmdData, LinkSnapshot } from "../link/envelope";
import { cards } from "./model";

export async function refreshView(
  client: ApiClient,
  view: { snapshot: LinkSnapshot; selected: number; now: number },
): Promise<{ snapshot: LinkSnapshot; selected: number }> {
  const selectedId = cards(view.snapshot, view.now).flatMap(g => g.cards)[view.selected]?.id;
  const { snapshot } = await client.snapshot();
  const updated = cards(snapshot, view.now).flatMap(g => g.cards);
  const index = updated.findIndex(card => card.id === selectedId);
  return { snapshot, selected: index >= 0 ? index : Math.max(0, Math.min(view.selected, updated.length - 1)) };
}


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

function reportApiError(error: unknown, report: (s: string) => void): void {
  if (!(error instanceof ApiError)) throw error;
  report(`pacer: ${error.message}${error.hint ? ` (${error.hint})` : ""}`);
}

export async function runCommand(
  client: ApiClient,
  data: CmdData,
  fallback: (d: CmdData) => Promise<void>,
  report: (s: string) => void,
): Promise<void> {
  const command = cmdToOp(data);
  if (!command) { await fallback(data); return; }
  try {
    switch (command.op) {
      case "task.stop": {
        const result = await client.call<{ task_id: string }>(command.op, command.params);
        report(`${result.task_id} stopped`); break;
      }
      case "task.retry": {
        const result = await client.call<{ retry: { task_id: string }; of: { task_id: string } }>(command.op, command.params);
        report(`${result.retry.task_id} queued (retry of ${result.of.task_id})`); break;
      }
      case "task.dismiss": {
        const result = await client.call<{ dismissed: string[]; unknown: string[] }>(command.op, command.params);
        report(`dismissed ${result.dismissed.length}${result.unknown.length ? `; unknown: ${result.unknown.join(", ")}` : ""}`); break;
      }
      default:
        await client.call(command.op, command.params);
        report(command.op === "strategy.use" ? `active strategy: ${data.strategy}` : `${data.cmd === "block" ? "blocked" : "unblocked"} ${data.executor}`);
    }
  } catch (error) { reportApiError(error, report); }
}

export async function delegateViaClient(
  client: ApiClient,
  input: { goal: string; repo: string; kind?: string },
  report: (s: string) => void,
): Promise<void> {
  try {
    const result = await client.call<{ task_id: string }>("task.delegate", {
      goal: input.goal, repo: input.repo, ...(input.kind ? { kind: input.kind } : {}),
    });
    report(`${result.task_id} queued`);
  } catch (error) { reportApiError(error, report); }
}
