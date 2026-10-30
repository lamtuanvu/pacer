import { resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { localMachineGuard, slotLimit, type SlotUse } from "../engine/slots";
import type { MachineWait, QueueReason } from "./types";

export interface QueueCapacity {
  reason: Extract<QueueReason, "no_slot" | "machine_memory_pressure" | "machine_load">;
  limit: "executor" | "host" | "machine";
  capacity?: {used: number; max: number};
  detail?: string;
  machine?: MachineWait;
}

/** Use the same precedence as slotBlock when several limits are full. */
export function queueCapacity(strategy: Strategy, executor: string, use: SlotUse): QueueCapacity | undefined {
  const runner = resolveRunner(strategy, executor), limits = slotLimit(strategy, executor);
  const used = use.byExecutor[runner?.id ?? executor] ?? 0;
  if (used >= limits.executor) return {reason: "no_slot", limit: "executor", capacity: {used, max: limits.executor}};
  if (runner?.host && limits.host !== null) {
    const used = use.byHost[runner.host] ?? 0;
    if (used >= limits.host) return {reason: "no_slot", limit: "host", capacity: {used, max: limits.host}};
  }
  if (limits.local !== null && use.local >= limits.local) {
    return {reason: "no_slot", limit: "machine", capacity: {used: use.local, max: limits.local}};
  }
  const guard = localMachineGuard(strategy, executor);
  if (guard) return {reason: guard.reason, limit: "machine", detail: guard.detail, machine: guard.machine};
  return undefined;
}
