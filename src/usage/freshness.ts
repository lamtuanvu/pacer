import type { UsageReading, UsageWindow } from "../types";

const SHORT_WINDOW_S = 6 * 3600;

/** How long a window's numbers stay trustworthy after capture: 2 h for windows of 6 h or less, 24 h otherwise. */
export function staleAfterS(w: UsageWindow): number {
  return w.lengthS <= SHORT_WINDOW_S ? 2 * 3600 : 24 * 3600;
}

/** One staleness rule for every provider. Limit marks and reactive/unmetered readings never go stale. */
export function markFreshness(r: UsageReading, now: number): UsageReading {
  const exempt = r.source === "reactive" || r.source === "unmetered";
  const windows = r.windows.map((w) => ({
    ...w,
    stale: !exempt && w.name !== "limit" && (r.capturedAt === null || now - r.capturedAt > staleAfterS(w)),
  }));
  return { ...r, windows, stale: windows.length > 0 && windows.every((w) => w.stale) };
}
