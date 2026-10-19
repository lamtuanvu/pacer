import { parseRunnerId } from "../config/runner-id";
import { displayName as runnerName, names } from "../render/accounts";
/** Runner ids and known provider ids get their friendly name; anything else is shown as given. */
export const displayName = (id: string) => parseRunnerId(id) || Object.hasOwn(names, id) ? runnerName(id) : id;
export { duration, backIn, ago, elapsed, clock } from "./time";
/** Meter caption: "63% used · pace 77%" or the compact "63%·77". */
export function meterText(used: number | null, pace: number | null, style: "full" | "compact"): string {
  if (used === null) return "usage unknown";
  const u = Math.round(used), p = pace === null ? null : Math.round(pace);
  if (style === "compact") return p === null ? `${u}%` : `${u}%·${p}`;
  return p === null ? `${u}% used` : `${u}% used · pace ${p}%`;
}
