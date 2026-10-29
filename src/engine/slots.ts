import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { displayName } from "../render/accounts";
import type { TaskRecord } from "../tasks/types";

export interface SlotUse { byExecutor: Record<string, number>; byHost: Record<string, number>; local: number }
/** Task states that can hold a slot: running, and `needs_input` while its backend keeps the lane's worker live. */
export const SLOT_STATES: TaskRecord["state"][] = ["running", "needs_input"];
/**
 * Whether a task occupies an executor slot. A kept-alive worker still runs its agent, so it holds the slot until it is
 * released; once an answer attempt is created to reattach to it, the slot passes to that attempt.
 */
export function holdsSlot(task: TaskRecord): boolean {
  return task.state === "running" || (task.state === "needs_input" && !!task.live && !task.retriedBy);
}
export function slotUse(tasks: TaskRecord[]): SlotUse {
  const use: SlotUse = {byExecutor: {}, byHost: {}, local: 0};
  for (const task of tasks) {
    if (!holdsSlot(task)) continue;
    const executor = task.run?.executor ?? task.executor;
    if (executor) use.byExecutor[executor] = (use.byExecutor[executor] ?? 0) + 1;
    const host = task.run?.host ?? (executor ? parseRunnerId(executor)?.host : null);
    if (host) use.byHost[host] = (use.byHost[host] ?? 0) + 1;
    else use.local++;
  }
  return use;
}
export function slotLimit(s: Strategy, runnerId: string): {executor: number; host: number | null; local: number | null} {
  const runner = resolveRunner(s, runnerId);
  const host = runner?.host ? s.hosts[runner.host].maxTasks : null;
  return {executor: runner?.maxTasks ?? host ?? 1, host, local: host === null ? validateExecution(s.execution).localMaxTasks ?? 2 : null};
}
export function slotBlock(s: Strategy, runnerId: string, use: SlotUse): string | null {
  const runner = resolveRunner(s, runnerId), limit = slotLimit(s, runnerId);
  const used = use.byExecutor[runner?.id ?? runnerId] ?? 0;
  if (used >= limit.executor) return `${displayName(runner?.id ?? runnerId)} busy (${used}/${limit.executor})`;
  if (runner?.host && limit.host !== null && (use.byHost[runner.host] ?? 0) >= limit.host) return `${runner.host} busy (${use.byHost[runner.host]}/${limit.host})`;
  if (limit.local !== null && use.local >= limit.local) return `this machine busy (${use.local}/${limit.local})`;
  return null;
}
