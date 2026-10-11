import type { Verdict } from "../types";

export type Mode = "strict" | "normal" | "relaxed" | "emergency";

export function plannerMode(v: Verdict): Mode {
  switch (v) {
    case "EXHAUSTED": return "emergency";
    case "AHEAD":
    case "NEAR_LIMIT": return "strict";
    case "BEHIND":
    case "EXPIRING": return "relaxed";
    default: return "normal";
  }
}
