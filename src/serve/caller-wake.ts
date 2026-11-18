import type { Ctx } from "../types";
import type { CallerReach } from "../messaging/caller-reach";
import type { CallerWakeResult } from "../messaging/broker";
import { pingOrcaCaller } from "../exec/orca/caller-ping";
import { callerAlive } from "../messaging/caller-reach";
import { resumeCaller } from "../install/planner-resume";
import type { PlannerKind } from "../messaging/identity";

/** Test seam only; production keeps resuming off. */
export let resumeEnabled = false;
export function setResumeEnabled(on: boolean): void { resumeEnabled = on; }

export async function callerWake(ctx: Ctx, reach: CallerReach, text: string, step: "ping" | "resume" = "ping", taskId: string = ""): Promise<CallerWakeResult> {
  try {
    if (step === "ping") {
      if (reach.terminal.kind !== "orca") return "unavailable";
      return await pingOrcaCaller(ctx, reach.terminal.handle, text);
    }
    // Resuming a closed caller stays off until it tracks the resumed child, passes budget admission and
    // refuses executor-written checkouts (follow-up PR); the ladder then falls through to notification.
    if (!resumeEnabled) return "unavailable";
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