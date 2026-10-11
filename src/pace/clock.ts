import { type ActivityProfile, hourBin } from "./activity";

const MIN_DAYS = 7;

export function isCalendar(p: ActivityProfile | null): boolean {
  return !p || p.days < MIN_DAYS || !p.active.some(Boolean);
}

/** Seconds of active time in [start, end]; plain calendar seconds when the profile is not usable. */
export function activeSeconds(start: number, end: number, p: ActivityProfile | null): number {
  if (end <= start) return 0;
  if (isCalendar(p)) return end - start;
  let total = 0;
  let t = start;
  while (t < end) {
    const hourEnd = (Math.floor(t / 3600) + 1) * 3600;
    const seg = Math.min(end, hourEnd) - t;
    if (p!.active[hourBin(t)]) total += seg;
    t += seg;
  }
  return total;
}

/** Share (0-100) of the window's active time already elapsed at `now`. */
export function pacePct(start: number, end: number, now: number, p: ActivityProfile | null): number {
  const total = activeSeconds(start, end, p);
  if (total <= 0) return 0;
  return (100 * activeSeconds(start, Math.min(now, end), p)) / total;
}

export function activeHoursLeft(now: number, end: number, p: ActivityProfile | null): number {
  return activeSeconds(now, end, p) / 3600;
}
