import { parseRunnerId } from "../config/runner-id";
import { displayName as runnerName, names } from "../render/accounts";
/** Runner ids and known provider ids get their friendly name; anything else is shown as given. */
export const displayName = (id: string) => parseRunnerId(id) || Object.hasOwn(names, id) ? runnerName(id) : id;
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
/** Absolute 24-hour time: "11:58" today, "Tue 11:58" within the week, else "1 Oct 11:58". */
export function clock(at: number, now: number, timeZone?: string): string {
  const date = new Date(at * 1000), opts = { timeZone, hourCycle: "h23" as const };
  const time = date.toLocaleTimeString("en-GB", { ...opts, hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-CA", opts);
  if (day(at) === day(now)) return time;
  if (now - at < 6 * 86400 && at <= now) return `${date.toLocaleDateString("en-GB", { ...opts, weekday: "short" })} ${time}`;
  return `${date.toLocaleDateString("en-GB", { ...opts, day: "numeric", month: "short" })} ${time}`;
}
/** Meter caption: "63% used · pace 77%" or the compact "63%·77". */
export function meterText(used: number | null, pace: number | null, style: "full" | "compact"): string {
  if (used === null) return "usage unknown";
  const u = Math.round(used), p = pace === null ? null : Math.round(pace);
  if (style === "compact") return p === null ? `${u}%` : `${u}%·${p}`;
  return p === null ? `${u}% used` : `${u}% used · pace ${p}%`;
}
