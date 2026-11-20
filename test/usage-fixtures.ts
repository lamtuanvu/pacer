/** Test fixtures for ADR 0030: build a UsageState record from the row fields older fixtures carry. */
import type { UsageState, Verdict } from "../src/types";

const verdictOf = (verdict: string | null | undefined): Verdict => {
  const mapped = ({ behind: "BEHIND", on_pace: "ON_PACE", ahead: "AHEAD", out: "EXHAUSTED", unknown: "UNKNOWN", UNMETERED: "UNMETERED", EXHAUSTED: "EXHAUSTED", NEAR_LIMIT: "NEAR_LIMIT", AHEAD: "AHEAD", BEHIND: "BEHIND", ON_PACE: "ON_PACE", OK: "OK", EXPIRING: "EXPIRING" } as Record<string, Verdict>)[verdict ?? ""];
  return mapped ?? "UNKNOWN";
};

/** One usageState record over the legacy row fields (usedPct, window, resetsAt, stale, verdict). */
export function usageStateFor(
  row: { usedPct?: number | null; window?: string | null; resetsAt?: number | null; stale?: boolean | null; verdict?: string | null; source?: string | null; capturedAt?: number | null },
  now: number,
): UsageState {
  const stale = row.stale === true;
  const window = row.window ?? (row.usedPct != null ? "weekly" : null);
  const lengthS = window === "5h" ? 5 * 3600 : window === "monthly" ? 30 * 86400 : 7 * 86400;
  const observedAt = row.capturedAt !== undefined ? row.capturedAt : row.usedPct == null ? null : stale ? now - 26 * 3600 : now - 60;
  return {
    scope: { account: "fixture" },
    source: (row.source as UsageState["source"]) ?? "provider-cli",
    figure: row.usedPct == null ? null : { usedPct: row.usedPct, window: window ?? "weekly", lengthS, resetsAt: row.resetsAt ?? null },
    windows: row.usedPct == null || !window ? [] : [{
      name: window, usedPct: row.usedPct, resetsAt: row.resetsAt ?? null, lengthS, paced: false, stale,
      verdict: verdictOf(row.verdict),
    }],
    limit: null,
    blockedRunners: [],
    observedAt,
    freshness: row.usedPct == null ? (stale ? "historical" : "unknown") : stale ? "historical" : "fresh",
    verdict: verdictOf(row.verdict),
    eligibility: { state: "eligible", reasons: [], evaluatedAt: now, validUntil: null, evidenceAgeS: 0, availability: "ready", budget: "permitted", spendingRisk: "unknown" },
    spend: null,
    error: null,
  };
}

/** A snapshot with usageState records derived from its legacy rows, for app UI fixtures. */
export function withUsageState<S>(snapshot: S, now?: number): S {
  const s = snapshot as { at?: number; planner?: Record<string, unknown> | null; executors?: Record<string, unknown>[]; accounts?: Record<string, unknown>[] };
  const at = now ?? s.at ?? 1800000000;
  return {
    ...s,
    planner: s.planner ? { ...s.planner, usageState: usageStateFor(s.planner as never, at) } : s.planner,
    executors: s.executors?.map(row => ({ ...row, usageState: usageStateFor(row as never, at) })),
    accounts: s.accounts?.map(row => ({ ...row, usageState: usageStateFor(row as never, at) })),
  } as S;
}
