import type { Ctx } from "../types";
import type { CallerReach } from "../messaging/caller-reach";
import type { CallerWakeResult } from "../messaging/broker";
import { pingOrcaCaller } from "../exec/orca/caller-ping";
import { callerAlive } from "../messaging/caller-reach";
import { resumeCaller } from "../install/planner-resume";
import type { PlannerKind } from "../messaging/identity";

export async function callerWake(ctx: Ctx, reach: CallerReach, text: string, step: "ping" | "resume" = "ping", taskId: string = ""): Promise<CallerWakeResult> {
  try {
    if (step === "ping") {
      if (reach.terminal.kind !== "orca") return "unavailable";
      return await pingOrcaCaller(ctx, reach.terminal.handle, text);
    }
    const kind: PlannerKind | null =
      reach.participant.startsWith("external:claude-code:") ? "claude-code"
      : reach.participant.startsWith("external:codex:") ? "codex"
      : null;
    if (!kind) return "unavailable";
    return await resumeCaller(ctx, { kind, session: reach.session, cwd: reach.cwd }, text, {
      task: taskId,
      isAlive: async () => (await callerAlive(ctx, reach)) !== "gone",
    });
  } catch {
    return "unavailable";
  }
}