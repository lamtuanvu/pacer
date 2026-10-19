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
/** Calendar-aware local time shared by all surfaces. Timestamps are Unix seconds. */
export function clock(at: number, now: number, timeZone?: string): string {
  const date = new Date(at * 1000), opts = { timeZone, hourCycle: "h23" as const };
  const time = date.toLocaleTimeString("en-GB", { ...opts, hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date(t * 1000));
    const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
    return Date.UTC(part("year"), part("month") - 1, part("day")) / 86400000;
  };
  const days = day(now) - day(at);
  if (days === 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString("en-GB", { ...opts, weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-GB", { ...opts, day: "numeric", month: "short", ...(date.toLocaleDateString("en-GB", { timeZone, year: "numeric" }) !== new Date(now * 1000).toLocaleDateString("en-GB", { timeZone, year: "numeric" }) ? {year: "numeric" as const} : {}) })} ${time}`;
}
