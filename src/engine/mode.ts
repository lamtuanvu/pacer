import type { ModeHold } from "../core/mode-hold";
import type { UsageState } from "../types";
import type { Verdict } from "../types";

export type Mode = "strict" | "normal" | "relaxed" | "emergency";

export function plannerMode(v: Verdict): Mode {
  switch (v) {
    case "EXHAUSTED": return "emergency";
    case "AHEAD":
    case "NEAR_LIMIT": return "strict";
    case "BEHIND":
    case "EXPIRING": return "relaxed";
    case "UNMETERED": return "normal";
    default: return "normal";
  }
}

/** An active hold wins; otherwise mode follows the planner's own runner record (ADR 0030). */
export function statusMode(modeHold: ModeHold | null | undefined, plannerRecord: UsageState | undefined): Mode {
  if (modeHold) return modeHold.mode;
  return plannerRecord ? plannerMode(plannerRecord.verdict) : "normal";
}
