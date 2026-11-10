import type { Strategy } from "../config/strategy";
import { TIER, accountYielded, type ProviderStatus, type RankedExecutor } from "./rank";
import { slotLimit, type SlotUse } from "./slots";
import type { Verdict } from "../types";

/**
 * Load utilization of one executor: tasks running on it over its own `max_tasks` (falls back to
 * the host or 1). `used` counts the same `SlotUse` that admission checks, so the two agree.
 */
export function utilization(s: Strategy, id: string, use: SlotUse): number {
  const limit = slotLimit(s, id).executor;
  if (!Number.isFinite(limit) || limit <= 0) return (use.byExecutor[id] ?? 0) > 0 ? Infinity : 0;
  return (use.byExecutor[id] ?? 0) / limit;
}

/** Budget-acceptability tier of a verdict: EXPIRING first, NEAR_LIMIT behind the normal band, AHEAD last. */
function verdictTier(v: Verdict): number {
  if (v === "EXPIRING") return 0;
  if (v === "NEAR_LIMIT") return 2;
  if (v === "AHEAD") return 3;
  return 1; // BEHIND, ON_PACE, UNKNOWN and anything else share the normal band.
}

/**
 * Reorders ranked candidates so work spreads by load: it stable-sorts each run of adjacent,
 * equally budget-acceptable candidates ("band") by `used / max_tasks`, ties keeping the policy
 * order. Band order — uncertain last, verdict tiers with NEAR_LIMIT split behind the normal band,
 * fill yield and the cheapest-first usage tier — is never changed. Bands only cover full
 * utilization sorts where `utilization >= 1` cannot happen after the busy filter, and in previews
 * such candidates sort to the end of their band. Returns a new array and never mutates its input.
 */
export function balanceByLoad(
  ranked: RankedExecutor[], s: Strategy, use: SlotUse, statuses: Record<string, ProviderStatus>,
): RankedExecutor[] {
  if (s.pacing.balance !== "least-loaded") return ranked;
  const fill = s.pacing.accounts === "fill";
  const cheapest = s.pacing.policy === "cheapest-first";
  const bandKey = (e: RankedExecutor): string => [
    e.fallback === "uncertain" ? 1 : 0,
    verdictTier(e.verdict),
    fill ? (accountYielded(s, e.id, statuses) ? 1 : 0) : 0,
    cheapest ? (TIER[statuses[e.id]?.usage ?? "quota"] ?? 99) : 0,
  ].join("|");
  const keyed = ranked.map(bandKey);
  const out = [...ranked];
  let start = 0;
  for (let i = 1; i <= ranked.length; i++) {
    if (i < ranked.length && keyed[i] === keyed[start]) continue;
    const end = i;
    if (end - start > 1) {
      const band = out.slice(start, end).map((e, j) => ({ e, j, u: utilization(s, e.id, use) }));
      band.sort((x, y) => x.u - y.u || x.j - y.j);
      for (let k = start; k < end; k++) {
        const { e } = band[k - start];
        const used = use.byExecutor[e.id] ?? 0;
        const load = ` · load ${used}/${slotLimit(s, e.id).executor}`;
        out[k] = e.reason.endsWith(load) ? e : { ...e, reason: e.reason + load };
      }
    }
    start = i;
  }
  return out;
}
