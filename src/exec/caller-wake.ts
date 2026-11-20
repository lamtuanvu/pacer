import type { CallerReach } from "../messaging/caller-reach";
import type { CallerWakeResult } from "../messaging/broker";
import type { Ctx } from "../types";
import { pingOrcaCaller } from "./orca/caller-ping";

/** The ladder has already proven the caller alive in a terminal pacer controls; only the typing lives here (ARCH-4). */
export async function callerWake(ctx: Ctx, reach: CallerReach, text: string): Promise<CallerWakeResult> {
  if (reach.terminal.kind !== "orca") return "unavailable";
  return pingOrcaCaller(ctx, reach.terminal.handle, text);
}
