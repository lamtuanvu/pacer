import type { EligibilityDecision, EvidenceScope } from "../evidence/types";
import { resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { UsageKind, Verdict } from "../types";
import type { WindowStatus } from "./verdict";
import { restrictEligibility } from "./eligibility";
import { eligibilityPresentation } from "../view-model/eligibility";

export interface ProviderStatus {
  eligibility?: EligibilityDecision;
  evidenceScope?: EvidenceScope;
  evidenceRevision?: number;
  id: string;
  /** Present for account-form strategies; legacy presentation stays unchanged. */
  agent?: string;
  account?: string;
  usage: UsageKind;
  windows: WindowStatus[];
  binding: WindowStatus | null;
  verdict: Verdict;
  installed: boolean;
  unavailableReason?: string;
  signedOutReason?: string;
  /** A managed endpoint whose test task has not run yet. Still routable (endpoint spec §5). */
  endpointNotTested?: true;
  stale: boolean;
  error?: string;
  brokenReason?: string;
  blockedReason?: string;
  blockedUntil?: number | null;
}
export interface RankedExecutor { eligibility?: EligibilityDecision; fallback?: "uncertain"; id: string; account?: string; score: number; verdict: Verdict; reason: string }
export interface Excluded { eligibility?: EligibilityDecision; id: string; account?: string; reason: string }

const EXPIRING_BOOST = 50;
const TIER: Record<UsageKind, number> = { unmetered: 0, quota: 1, reactive: 1, metered: 2 };

export function ruleFor(kind: string | null, s: Strategy): { index: number; kinds: string[] | null } {
  let index = kind ? s.routing.findIndex(r => r.kinds?.includes(kind)) : -1;
  if (index < 0) index = s.routing.findIndex(r => r.kinds === null);
  return { index, kinds: s.routing[index]?.kinds ?? null };
}

export function executorsFor(kind: string | null, s: Strategy): string[] {
  const rule = s.routing[ruleFor(kind, s).index];
  return (rule ? rule.executors : Object.keys(s.runners)).map(id => resolveRunner(s, id)?.id ?? id);
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

export interface CandidateSelection { executors: readonly string[]; order: "configured" }

export function rankExecutors(
  kind: string | null, s: Strategy, statuses: Record<string, ProviderStatus>, selection?: CandidateSelection,
): { ranked: RankedExecutor[]; excluded: Excluded[]; uncertain?: RankedExecutor[]; reason?: string } {
  statuses = Object.fromEntries(Object.entries(statuses).map(([id, status]) => [resolveRunner(s, id)?.id ?? id, status]));
  const ranked: (RankedExecutor & { unknown: boolean; order: number })[] = [];
  const excluded: Excluded[] = [];
  [...new Set(selection?.executors ?? executorsFor(kind, s))].forEach((id, order) => {
    const st = statuses[id];
    const runner = s.runners[id];
    const account = runner ? s.accounts[runner.account] : undefined;
    const accountField = runner ? { account: runner.account } : {};
    const exclude = (reason: string) => excluded.push({ id, ...accountField, reason,
      eligibility: restrictEligibility(st?.eligibility, reason === "planner" ? "planner" : "unavailable") });
    if (runner?.agent === s.planner.agent && runner.account === s.planner.account) return exclude("planner");
    if (runner?.enabled === false) return exclude("disabled");
    if (!st || !runner || !account) return exclude("not configured");
    if (st.unavailableReason) return exclude(st.unavailableReason);
    if (st.blockedReason) return exclude("Blocked by you");
    if (st.brokenReason) return exclude(`Not working · ${st.brokenReason}`);
    if (!st.installed) return exclude("not installed");
    if (st.signedOutReason) return exclude(st.signedOutReason);
    const decision = restrictEligibility(st.eligibility);
    if (decision.state === "ineligible") {
      excluded.push({ id, ...accountField, reason: eligibilityPresentation(decision, decision.evaluatedAt).detail, eligibility: decision });
      return;
    }
    const uncertain = decision.state === "uncertain";
    ranked.push({ id, ...accountField, eligibility: decision,
      ...(uncertain ? { fallback: "uncertain" as const } : {}), score: score(st, s), verdict: st.verdict, reason: uncertain ? `Uncertain fallback: ${eligibilityPresentation(decision, decision.evaluatedAt).detail}` : reason(st), unknown: uncertain, order });
  });
  if (selection) {
    ranked.sort((a, b) => Number(a.unknown) - Number(b.unknown) || a.order - b.order);
    return {
      ranked: ranked.map(({ unknown, order, ...executor }, index) => ({ ...executor, score: ranked.length - index })),
      uncertain: ranked.filter(e => e.unknown).map(({ unknown, order, ...executor }) => executor),
      excluded,
      ...(!selection.executors.some(id => s.runners[id] && !(s.runners[id].agent === s.planner.agent && s.runners[id].account === s.planner.account)) ? { reason: "no executor configured" } : {}),
    };
  }
  if (s.pacing.policy === "priority") {
    const sequence: typeof ranked = [];
    const placed = new Set<string>();
    const append = (candidate: (typeof ranked)[number]) => {
      if (!placed.has(candidate.id)) {
        sequence.push(candidate);
        placed.add(candidate.id);
      }
    };
    for (const reference of s.pacing.order) {
      const id = reference === "opencode" ? reference : resolveRunner(s, reference)?.id ?? reference;
      if (id === "opencode") {
        ranked.filter((e) => s.runners[e.id].agent === "opencode").forEach(append);
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
  } else {
    ranked.sort((a, b) => Number(a.unknown) - Number(b.unknown) || b.score - a.score || a.order - b.order);
  }
  // Preserve the policy's slots between agents and account kinds. Endpoint
  // accounts are distinct providers and retain the policy's ordering.
  const group = (id: string) => {
    const runner = s.runners[id];
    return `${runner.agent}:${s.accounts[runner.account].kind}`;
  };
  for (const key of new Set(ranked.filter(e => s.accounts[s.runners[e.id].account].kind !== "endpoint").map(e => group(e.id)))) {
    const positions = ranked.flatMap((e, i) => {
      if (group(e.id) !== key) return [];
      // Keep unmeasured accounts in the existing policy's slots.
      if (s.pacing.accounts === "spread" && statuses[e.id].binding?.usedPct == null) return [];
      return [i];
    });
    const candidates = positions.map(i => ranked[i]);
    if (new Set(candidates.map(e => s.runners[e.id].account)).size < 2) continue;
    const preference = [...new Set(s.pacing.order.flatMap(id => id === "opencode"
      ? executorsFor(kind, s).filter(id => s.runners[id]?.agent === "opencode") : [id]))];
    const order = (id: string) => {
      const account = s.runners[id].account;
      const i = preference.findIndex(name => s.runners[name]?.account === account);
      return i < 0 ? preference.length : i;
    };
    const headroom = (id: string) => {
      const st = statuses[id];
      return st.binding?.delta !== undefined ? -st.binding.delta : 100 - (st.binding?.usedPct ?? 100);
    };
    const yielded = (id: string) => statuses[id].windows.some(w => w.verdict === "BEHIND" || w.verdict === "AHEAD" || (w.usedPct ?? 0) >= s.pacing.fillThreshold);
    candidates.sort((a, b) => {
      if (s.pacing.accounts === "fill") return Number(yielded(a.id)) - Number(yielded(b.id)) || order(a.id) - order(b.id) || a.order - b.order;
      return Number(a.unknown) - Number(b.unknown) || headroom(b.id) - headroom(a.id) || order(a.id) - order(b.id) || a.order - b.order;
    });
    positions.forEach((position, i) => { ranked[position] = candidates[i]; });
  }
  ranked.sort((a, b) => Number(a.unknown) - Number(b.unknown));
  if (s.pacing.policy === "priority") ranked.forEach((e, i) => { e.score = ranked.length - i; });
  const configured = executorsFor(kind, s).some(id => {
    const runner = s.runners[id];
    return runner && !(runner.agent === s.planner.agent && runner.account === s.planner.account);
  });
  return { ranked: ranked.map(({ unknown, order, ...executor }) => executor), excluded,
    uncertain: ranked.filter(e => e.unknown).map(({ unknown, order, ...executor }) => executor),
    ...(!configured ? { reason: "no executor configured" } : {}) };
}
