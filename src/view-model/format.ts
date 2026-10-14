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
