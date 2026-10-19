import { resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { slotLimit, type SlotUse } from "../engine/slots";

/** Use the same precedence as slotBlock when several limits are full. */
export function queueCapacity(strategy: Strategy, executor: string, use: SlotUse) {
  const runner = resolveRunner(strategy, executor), limits = slotLimit(strategy, executor);
  const used = use.byExecutor[runner?.id ?? executor] ?? 0;
  if (used >= limits.executor) return {limit: "executor" as const, capacity: {used, max: limits.executor}};
  if (runner?.host && limits.host !== null) {
    const used = use.byHost[runner.host] ?? 0;
    if (used >= limits.host) return {limit: "host" as const, capacity: {used, max: limits.host}};
  }
  if (limits.local !== null && use.local >= limits.local) {
    return {limit: "machine" as const, capacity: {used: use.local, max: limits.local}};
  }
  return undefined;
}
