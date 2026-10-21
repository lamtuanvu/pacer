import type { UsageReading, UsageWindow } from "../types";

/** Bounded age applies even when an observation reported exhaustion. */
export function staleAfterS(w: UsageWindow): number {
  return w.lengthS <= 6 * 3600 ? 7200 : 86400;
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
