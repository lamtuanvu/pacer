import type { ActivityProfile } from "../pace/activity";
import { activeHoursLeft, pacePct } from "../pace/clock";
import type { UsageWindow, Verdict } from "../types";

export const EXHAUSTED_PCT = 97;
export const NEAR_LIMIT_PCT = 90;
export const EXPIRING_HOURS = 9;
export const EXPIRING_UNUSED = 25;

export interface WindowStatus extends UsageWindow {
  verdict: Verdict;
  pace?: number;
  delta?: number;
  activeHoursLeft?: number;
  rolled?: boolean;
}
export interface Thresholds { ahead: number; behind: number; paceScale: number }

export function evaluateWindow(w: UsageWindow, now: number, profile: ActivityProfile | null, th: Thresholds): WindowStatus {
  const s: WindowStatus = { ...w, verdict: "UNKNOWN" };
  if (s.resetsAt !== null && s.resetsAt <= now) {
    return { ...s, stale: true, rolled: true };
  }
  if (s.stale) return s;
  if (s.usedPct === null) return s;
  const used = s.usedPct;
  if (used >= EXHAUSTED_PCT) return { ...s, verdict: "EXHAUSTED" };
  if (!s.paced || s.resetsAt === null) return { ...s, verdict: used >= NEAR_LIMIT_PCT ? "NEAR_LIMIT" : "OK" };
  const pace = pacePct(s.resetsAt - s.lengthS, s.resetsAt, now, profile) * th.paceScale;
  const hoursLeft = activeHoursLeft(now, s.resetsAt, profile);
  const delta = used - pace;
  let verdict: Verdict;
  if (hoursLeft <= EXPIRING_HOURS && 100 - used >= EXPIRING_UNUSED) verdict = "EXPIRING";
  else if (delta > th.ahead) verdict = "AHEAD";
  else if (delta < th.behind) verdict = "BEHIND";
  else verdict = "ON_PACE";
  return { ...s, verdict, pace, delta, activeHoursLeft: hoursLeft };
}

const RANK: Record<Verdict, number> = {
  EXHAUSTED: 0, NEAR_LIMIT: 1, AHEAD: 2, UNKNOWN: 3, OK: 3, ON_PACE: 4, BEHIND: 5, EXPIRING: 6,
};

/** The window that decides a provider's verdict. */
export function bindingWindow(ws: WindowStatus[]): WindowStatus | null {
  const known = ws.filter((w) => w.verdict !== "UNKNOWN");
  if (!known.length) return ws[0] ?? null;
  const hard = known.filter((w) => w.verdict === "EXHAUSTED" || w.verdict === "NEAR_LIMIT" || w.verdict === "AHEAD");
  if (hard.length) return hard.reduce((a, b) => (RANK[b.verdict] < RANK[a.verdict] ? b : a));
  const paced = known.filter((w) => w.pace !== undefined);
  if (paced.length) return paced.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a));
  return known[0];
}
