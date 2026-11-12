export function duration(seconds: number, long = false): string {
  const minutes = Math.max(0, Math.floor(seconds / 60)), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (long) return days ? `${days} ${days === 1 ? "day" : "days"} ${hours % 24} ${hours % 24 === 1 ? "hour" : "hours"}` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}
export const backIn = (at: number | null, now: number) => at === null ? "reset unknown" : `back in ${duration(at - now)}`;
/** Relative time for live sections: "8s ago", "14m ago", "3h ago", "2d ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.floor(now - at));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}
/** Running time without "ago": "14m", "1h 05m". */
export function elapsed(seconds: number): string {
  const m = Math.max(0, Math.floor(seconds / 60)), h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
/** Readable duration for captions: "<1 min", "2 min", "1 h 5 min". */
export function durationWords(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  const hours = Math.floor(minutes / 60);
  if (!minutes) return "<1 min";
  if (!hours) return `${minutes} min`;
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}
/** Local calendar-day number (Unix days) for a timestamp, independent of DST and timezone. */
function localDay(t: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(t * 1000));
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
}
function timeOfDay(t: number, timeZone?: string): string {
  return new Date(t * 1000).toLocaleTimeString("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
}
function weekdayOf(t: number, timeZone?: string): string {
  return new Date(t * 1000).toLocaleDateString("en-GB", { timeZone, weekday: "short" });
}
function dateOf(t: number, now: number, timeZone?: string): string {
  const date = new Date(t * 1000);
  const sameYear = date.toLocaleDateString("en-GB", { timeZone, year: "numeric" }) === new Date(now * 1000).toLocaleDateString("en-GB", { timeZone, year: "numeric" });
  return date.toLocaleDateString("en-GB", { timeZone, day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" as const }) });
}
export interface ClockParts { days: number; time: string; weekday: string; date: string }
/** Bounded calendar-aware local pieces for a timestamp, reused by clock() and the exit strip's relative form. */
export function clockParts(at: number, now: number, timeZone?: string): ClockParts {
  return { days: localDay(now, timeZone) - localDay(at, timeZone), time: timeOfDay(at, timeZone), weekday: weekdayOf(at, timeZone), date: dateOf(at, now, timeZone) };
}
/** Calendar-aware local time shared by all surfaces. Timestamps are Unix seconds. */
export function clock(at: number, now: number, timeZone?: string): string {
  const { days, time, weekday, date } = clockParts(at, now, timeZone);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${weekday} ${time}`;
  return `${date} ${time}`;
}
