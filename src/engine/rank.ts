import type { Strategy } from "../config/strategy";
import type { UsageKind, Verdict } from "../types";
import type { WindowStatus } from "./verdict";

export interface ProviderStatus {
  id: string;
  usage: UsageKind;
  windows: WindowStatus[];
  binding: WindowStatus | null;
  verdict: Verdict;
  installed: boolean;
  stale: boolean;
  error?: string;
  brokenReason?: string;
  blockedReason?: string;
  blockedUntil?: number | null;
}
export interface RankedExecutor { id: string; score: number; verdict: Verdict; reason: string }
export interface Excluded { id: string; reason: string }

const EXPIRING_BOOST = 50;
const TIER: Record<UsageKind, number> = { unmetered: 0, quota: 1, reactive: 1, metered: 2 };

export function executorsFor(kind: string | null, s: Strategy): string[] {
  const rule = (kind && s.routing.find((r) => r.kinds?.includes(kind))) || s.routing.find((r) => r.kinds === null);
  return rule ? rule.executors : Object.keys(s.providers);
}

function score(st: ProviderStatus, s: Strategy): number {
  const b = st.binding;
  const behind = b?.delta !== undefined ? -b.delta : 0;
  let base: number;
  switch (s.pacing.policy) {
    case "priority":
      return 0; // Assigned from the final position after applying guardrails.
    case "even":
      base = behind;
      break;
    case "burn-before-reset": {
      const unused = b?.usedPct != null ? 100 - b.usedPct : 0;
      base = unused / Math.max(1, b?.activeHoursLeft ?? 168);
      break;
    }
    case "cheapest-first":
      base = -TIER[st.usage] * 1000 + behind;
      break;
  }
  if (st.verdict === "EXPIRING" && s.pacing.policy !== "cheapest-first") base += EXPIRING_BOOST;
  return base;
}

function reason(st: ProviderStatus): string {
  const b = st.binding;
  const bits = [st.verdict.toLowerCase().replace("_", " ")];
  if (b?.usedPct != null) bits.push(b.pace !== undefined ? `used ${b.usedPct.toFixed(0)}% / pace ${b.pace.toFixed(0)}%` : `used ${b.usedPct.toFixed(0)}%`);
  return bits.join(", ");
}

export function rankExecutors(
  kind: string | null, s: Strategy, statuses: Record<string, ProviderStatus>,
): { ranked: RankedExecutor[]; excluded: Excluded[] } {
  const ranked: (RankedExecutor & { unknown: boolean; order: number })[] = [];
  const excluded: Excluded[] = [];
  [...new Set(executorsFor(kind, s))].forEach((id, order) => {
    const st = statuses[id];
    const cfg = s.providers[id];
    if (id === s.planner) return excluded.push({ id, reason: "planner" });
    if (!st || !cfg) return excluded.push({ id, reason: "not configured" });
    if (st.blockedReason) return excluded.push({id,reason:"Blocked by you"});
    if (st.brokenReason) return excluded.push({ id, reason: `Not working · ${st.brokenReason}` });
    if (!st.installed) return excluded.push({ id, reason: "not installed" });
    if (st.verdict === "EXHAUSTED" && !cfg.allowPaid) return excluded.push({ id, reason: "exhausted" });
    ranked.push({ id, score: score(st, s), verdict: st.verdict, reason: reason(st), unknown: st.verdict === "UNKNOWN", order });
  });
  if (s.pacing.policy === "priority") {
    const sequence: typeof ranked = [];
    const placed = new Set<string>();
    const append = (candidate: (typeof ranked)[number]) => {
      if (!placed.has(candidate.id)) {
        sequence.push(candidate);
        placed.add(candidate.id);
      }
    };
    for (const id of s.pacing.order) {
      if (id === "opencode") {
        ranked.filter((e) => s.providers[e.id].via === "opencode").forEach(append);
      } else {
        const candidate = ranked.find((e) => e.id === id);
        if (candidate) append(candidate);
      }
    }
    ranked.forEach(append);
    ranked.splice(0, ranked.length,
      ...sequence.filter((e) => e.verdict === "EXPIRING"),
      ...sequence.filter((e) => e.verdict !== "EXPIRING" && e.verdict !== "AHEAD"),
      ...sequence.filter((e) => e.verdict === "AHEAD"),
    );
    for (let i = ranked.length - 2; i >= 0; i--) {
      if (ranked[i].unknown && !ranked[i + 1].unknown) {
        [ranked[i], ranked[i + 1]] = [ranked[i + 1], ranked[i]];
      }
    }
    ranked.forEach((e, i) => { e.score = ranked.length - i; });
  } else {
    ranked.sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.score - a.score || a.order - b.order);
  }
  return { ranked: ranked.map(({ id, score, verdict, reason }) => ({ id, score, verdict, reason })), excluded };
}
