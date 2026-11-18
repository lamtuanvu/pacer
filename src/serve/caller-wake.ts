import type { Ctx } from "../types";
import type { CallerReach } from "../messaging/caller-reach";
import type { CallerWakeResult } from "../messaging/broker";
import { pingOrcaCaller } from "../exec/orca/caller-ping";

export async function callerWake(ctx: Ctx, reach: CallerReach, text: string): Promise<CallerWakeResult> {
  try {
    if (reach.terminal.kind !== "orca") return "unavailable";
    return await pingOrcaCaller(ctx, reach.terminal.handle, text);
  } catch {
    return "unavailable";
  }
}