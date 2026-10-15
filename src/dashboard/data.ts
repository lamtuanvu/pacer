import { runMappedCmd } from "../api/cmd";
export { cmdToOp, CMD_SUCCESS, runMappedCmd } from "../api/cmd";
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
  const result = await runMappedCmd((op, params) => client.call(op, params), data);
  if (result.handled) report(result.message);
  else await fallback(data);
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
