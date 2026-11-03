import { addAgentSessionSlots } from "../session/agents-state";
import type { Ctx } from "../types";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { displayName } from "../render/accounts";
import type { TaskRecord } from "../tasks/types";
import { machineGuard, machineSignals, type MachineGuard, type MachineSignals } from "./machine";

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
export function slotUse(tasks: TaskRecord[], ctx?:Ctx, exceptSession?:string): SlotUse {
  const use: SlotUse = {byExecutor: {}, byHost: {}, local: 0};
  for (const task of tasks) {
    if (!holdsSlot(task)) continue;
    const executor = task.run?.executor ?? task.executor;
    if (executor) use.byExecutor[executor] = (use.byExecutor[executor] ?? 0) + 1;
    const host = task.run?.host ?? (executor ? parseRunnerId(executor)?.host : null);
    if (host) use.byHost[host] = (use.byHost[host] ?? 0) + 1;
    else use.local++;
  }
  return ctx ? addAgentSessionSlots(ctx,use,exceptSession) : use;
}
/** `local` is the hard cap shared by local executors; null for remote runners or when no fixed cap is set. */
export function slotLimit(s: Strategy, runnerId: string): {executor: number; host: number | null; local: number | null} {
  const runner = resolveRunner(s, runnerId);
  const host = runner?.host ? s.hosts[runner.host].maxTasks : null;
  return {executor: runner?.maxTasks ?? host ?? 1, host, local: host === null ? validateExecution(s.execution).localMaxTasks ?? null : null};
}
/** The machine guard that holds new starts for a local runner, if any. Remote runners keep their host's limits. */
export function localMachineGuard(s: Strategy, runnerId: string, signals?: MachineSignals): MachineGuard | null {
  if (resolveRunner(s, runnerId)?.host) return null;
  return machineGuard(validateExecution(s.execution), signals ?? machineSignals());
}
/**
 * Why a runner cannot take another task now. Hard caps always apply. The machine guard
 * applies only with `guard: true`: it gates fresh starts, never retries, previews or admission.
 */
export function slotBlock(s: Strategy, runnerId: string, use: SlotUse, opts: {guard?: boolean; signals?: MachineSignals} = {}): string | null {
  const runner = resolveRunner(s, runnerId), limit = slotLimit(s, runnerId);
  const used = use.byExecutor[runner?.id ?? runnerId] ?? 0;
  if (used >= limit.executor) return `${displayName(runner?.id ?? runnerId)} busy (${used}/${limit.executor})`;
  if (runner?.host && limit.host !== null && (use.byHost[runner.host] ?? 0) >= limit.host) return `${runner.host} busy (${use.byHost[runner.host]}/${limit.host})`;
  if (limit.local !== null && use.local >= limit.local) return `this machine busy (${use.local}/${limit.local})`;
  const guard = opts.guard ? localMachineGuard(s, runnerId, opts.signals) : null;
  if (guard) return `this machine waits: ${guard.detail}`;
  return null;
}
