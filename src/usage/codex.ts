import type { AccountCfg } from "../config/accounts";
import type { Ctx, UsageReading, UsageWindow } from "../types";
import { isObj, parseTs, toNum } from "../util";

export function findRateLimits(root: unknown): Record<string, unknown> | null {
  const stack: unknown[] = [root];
  while (stack.length) {
    const o = stack.pop();
    if (Array.isArray(o)) stack.push(...o);
    else if (isObj(o)) {
      if (isObj(o.rate_limits) && o.rate_limits.primary != null) return o.rate_limits;
      stack.push(...Object.values(o));
    }
  }
  return null;
}

export interface RateLimitObservation { rateLimits: Record<string, unknown>; observedAt: number | null; alternatives?: RateLimitObservation[] }
export function rateLimitObservation(event: unknown): RateLimitObservation | null {
  const rateLimits = findRateLimits(event);
  return rateLimits ? { rateLimits, observedAt: isObj(event) ? parseTs(event.timestamp) : null } : null;
}
export function readingFromObservation(observation: RateLimitObservation): UsageReading {
  const credits = observation.rateLimits.credits;
  return { windows: windowsFromRateLimits(observation.rateLimits, observation.observedAt), capturedAt: observation.observedAt,
    stale: false, source: "session-log",
    ...(observation.alternatives?.length ? { alternatives: observation.alternatives.map(readingFromObservation) } : {}),
    ...(isObj(credits) ? { spending: { creditsAvailable: typeof credits.has_credits === "boolean" ? credits.has_credits : null,
      creditBalance: toNum(typeof credits.balance === "string" && credits.balance.trim() ? Number(credits.balance) : credits.balance), paidConsumption: "unknown" as const } } : {}),
  };
}
/** Shared conversion for local rollout files and the SSH session-log probe. */
export function windowsFromRateLimits(rl: Record<string, unknown>, observedAt: number | null): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const mins = toNum(w.window_minutes) ?? 10080;
    let resetsAt = parseTs(w.resets_at);
    const inS = toNum(w.resets_in_seconds);
    if (resetsAt === null && inS !== null && observedAt !== null) resetsAt = observedAt + inS;
    windows.push({
      name: mins >= 7 * 1440 ? "weekly" : `${Math.round(mins / 60)}h`,
      usedPct: toNum(w.used_percent),
      resetsAt,
      lengthS: mins * 60,
      paced: mins >= 1440,
    });
  }
  return windows;
}

/** Compatibility reader: no local log discovery, cursor store, or fallback. */
export async function readCodex(ctx: Ctx, account?: AccountCfg): Promise<UsageReading> {
  return (await import("./plugin-readers")).readQuotaPlugin(ctx, "codex", account);
}
