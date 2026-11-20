import type { UsageReading, UsageWindow } from "../types";
import constants from "./freshness.constants.json";

/** Every freshness threshold is defined once here; the values live in freshness.constants.json. */
export const WINDOW_CAP_SHORT_MAX_LENGTH_S = constants.windowCapShortMaxLengthS;
export const WINDOW_CAP_SHORT_S = constants.windowCapShortS;
export const WINDOW_CAP_LONG_S = constants.windowCapLongS;
export const AUTH_LIFETIME_S = constants.authLifetimeS;
export const EXECUTION_LIFETIME_S = constants.executionLifetimeS;
export const SPENDING_LIFETIME_S = constants.spendingLifetimeS;
export const AVAILABILITY_FALLBACK_S = constants.availabilityFallbackS;
export const EXHAUSTED_PCT = constants.exhaustedPct;
export const NEAR_LIMIT_PCT = constants.nearLimitPct;
export const LIMIT_WINDOW_LENGTH_S = constants.limitWindowLengthS;
export const OBSERVATION_EXPIRY_S = constants.observationExpiryS;
export const USAGE_MEMO_S = constants.usageMemoS;
export const EVIDENCE_PRUNE_AFTER_S = constants.evidencePruneAfterS;

/** Bounded age applies even when an observation reported exhaustion. */
export function staleAfterS(w: UsageWindow): number {
  return w.lengthS <= WINDOW_CAP_SHORT_MAX_LENGTH_S ? WINDOW_CAP_SHORT_S : WINDOW_CAP_LONG_S;
}
export function markFreshness(r: UsageReading, now: number): UsageReading {
  const contract = r.source === "reactive" || r.source === "unmetered";
  const windows = r.windows.map(w => ({
    ...w,
    stale: (w.resetsAt !== null && w.resetsAt <= now) || (!contract && w.name !== "limit" &&
      (r.stale || r.capturedAt === null || !Number.isFinite(r.capturedAt) || r.capturedAt > now || now - r.capturedAt >= staleAfterS(w))),
  }));
  return { ...r, windows, stale: windows.length > 0 ? windows.some(w => w.stale) : r.stale };
}
