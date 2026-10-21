import type { Ctx, UsageReading, UsageWindow } from "../types";
import { isObj, parseTs, toNum } from "../util";
import { cachedFetch } from "./cache";

/** Same wall-clock instant one calendar month earlier (UTC), clamped to month end. */
export function monthBefore(ts: number): number {
  const d = new Date(ts * 1000);
  const t = new Date(d.getTime());
  t.setUTCMonth(d.getUTCMonth() - 1);
  if (t.getUTCDate() !== d.getUTCDate()) t.setUTCDate(0);
  return t.getTime() / 1000;
}

export async function readByteplus(ctx: Ctx, refresh = false): Promise<UsageReading> {
  const c = await cachedFetch(ctx, "arkcli-usage-plan", 600, 6 * 3600, async () => {
    const r = await ctx.run(["arkcli", "usage", "plan", "--product", "coding-plan"], 8000);
    if (r.code !== 0) throw new Error(`arkcli exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return JSON.parse(r.stdout) as unknown;
  }, { refresh });
  if (c.value === null) return { windows: [], capturedAt: null, stale: false, error: c.error };
  const items = isObj(c.value) && Array.isArray(c.value.items) ? c.value.items : null;
  if (!items) return { windows: [], capturedAt: c.capturedAt, stale: c.stale, source: "provider-cli",
    availability: { state: "unknown", reason: "subscription_response_invalid", validUntil: c.capturedAt === null ? null : c.capturedAt + 600 },
    error: "invalid coding-plan subscription response" };
  const item = items.find(i => isObj(i) && i.product === "coding-plan" && i.subscribed === true);
  if (!isObj(item)) {
    const explicit = !items.length || items.some(i => isObj(i) && i.product === "coding-plan" && i.subscribed === false);
    return { windows: [], capturedAt: c.capturedAt, stale: c.stale, source: "provider-cli",
      availability: { state: explicit && !c.stale ? "unavailable" : "unknown", reason: explicit ? "subscription_missing" : "subscription_response_invalid", validUntil: c.capturedAt === null ? null : c.capturedAt + 600 },
      error: c.error ?? "no active coding-plan subscription" };
  }
  const windows: UsageWindow[] = [];
  for (const per of Array.isArray(item.periods) ? item.periods : []) {
    if (!isObj(per)) continue;
    const usedPct = toNum(per.percent);
    const resetsAt = parseTs(per.reset_at);
    if (per.label === "session") {
      windows.push({ name: "5h", usedPct, resetsAt, lengthS: 5 * 3600, paced: false });
    } else if (per.label === "weekly") {
      windows.push({ name: "weekly", usedPct, resetsAt, lengthS: 7 * 86400, paced: true });
    } else if (per.label === "monthly") {
      const lengthS = resetsAt !== null ? resetsAt - monthBefore(resetsAt) : 30 * 86400;
      windows.push({ name: "monthly", usedPct, resetsAt, lengthS, paced: true });
    }
  }
  return { windows, capturedAt: c.capturedAt, stale: c.stale, error: c.error, source: "provider-cli",
    availability: { state: c.stale ? "unknown" : "ready", reason: "subscription_active", validUntil: c.capturedAt === null ? null : c.capturedAt + 600 } };
}
