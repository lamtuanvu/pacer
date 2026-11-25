import type { EligibilityDecision, EvidenceScope } from "../evidence/types";
import { isPlannerRunner, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { UsageKind, UsageState, Verdict } from "../types";
import type { WindowStatus } from "./verdict";
import { restrictEligibility } from "./eligibility";
import { eligibilityPresentation } from "../view-model/eligibility";
import { TIERS } from "../dispatch/candidates";
import type { TierTargets } from "../dispatch/types";

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
  /** The CoreError code behind `error`, when the usage read threw one. */
  errorCode?: string;
  brokenReason?: string;
  blockedReason?: string;
  blockedUntil?: number | null;
  /**
   * Additive: the runner's one usage record (ADR 0030). Named `usageState` because
   * `usage` has been this row's UsageKind since 3.0 and keeps that meaning.
   */
  usageState?: UsageState;
}
/** Set on the planner when it is ranked first because no other executor declares a model at the task's target tier. */
export interface TierFallback { targetTier: TierTargets["complex"]; reason: string }
export interface RankedExecutor { eligibility?: EligibilityDecision; fallback?: "uncertain"; id: string; account?: string; score: number; verdict: Verdict; reason: string; tierFallback?: TierFallback }
export interface Excluded { eligibility?: EligibilityDecision; id: string; account?: string; reason: string }

const EXPIRING_BOOST = 50;
export const TIER: Record<UsageKind, number> = { unmetered: 0, quota: 1, reactive: 1, metered: 2 };
/** Whether an account has yielded under `pacing.accounts: fill`: a window behind/ahead of pace or at `fill_threshold`. */
export function accountYielded(s: Strategy, id: string, statuses: Record<string, ProviderStatus>): boolean {
  return statuses[id]?.windows.some(w => w.verdict === "BEHIND" || w.verdict === "AHEAD" || (w.usedPct ?? 0) >= s.pacing.fillThreshold) ?? false;
}

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
  kind: string | null, s: Strategy, statuses: Record<string, ProviderStatus>, selection?: CandidateSelection, options: {includePlanner?: boolean; targetTier?: TierTargets["complex"]} = {},
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
    if (!options.includePlanner && runner?.agent === s.planner.agent && runner.account === s.planner.account) return exclude("planner");
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
    applyPlannerTierFallback(s, statuses, ranked, excluded, options.targetTier);
    return {
      ranked: ranked.map(({ unknown, order, ...executor }, index) => ({ ...executor, score: ranked.length - index })),
      uncertain: ranked.filter(e => e.unknown).map(({ unknown, order, ...executor }) => executor),
      excluded,
      ...(!selection.executors.some(id => s.runners[id] && (options.includePlanner || !(s.runners[id].agent === s.planner.agent && s.runners[id].account === s.planner.account))) ? { reason: "no executor configured" } : {}),
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
    const yielded = (id: string) => accountYielded(s, id, statuses);
    candidates.sort((a, b) => {
      if (s.pacing.accounts === "fill") return Number(yielded(a.id)) - Number(yielded(b.id)) || order(a.id) - order(b.id) || a.order - b.order;
      return Number(a.unknown) - Number(b.unknown) || headroom(b.id) - headroom(a.id) || order(a.id) - order(b.id) || a.order - b.order;
    });
    positions.forEach((position, i) => { ranked[position] = candidates[i]; });
  }
  ranked.sort((a, b) => Number(a.unknown) - Number(b.unknown));
  if (s.pacing.policy === "priority") ranked.forEach((e, i) => { e.score = ranked.length - i; });
  applyPlannerTierFallback(s, statuses, ranked, excluded, options.targetTier);
  const configured = executorsFor(kind, s).some(id => {
    const runner = s.runners[id];
    return runner && !(runner.agent === s.planner.agent && runner.account === s.planner.account);
  });
  return { ranked: ranked.map(({ unknown, order, ...executor }) => executor), excluded,
    uncertain: ranked.filter(e => e.unknown).map(({ unknown, order, ...executor }) => executor),
    ...(!configured ? { reason: "no executor configured" } : {}) };
}

type RankedEntry = RankedExecutor & { unknown: boolean; order: number };

function declaresTier(s: Strategy, id: string, target: TierTargets["complex"]): boolean {
  return (s.runners[id]?.models ?? []).some(m => m.tier !== "unknown" && TIERS[m.tier] >= TIERS[target]);
}

/**
 * Planner tier fallback (docs/specs/2026-11-25-planner-tier-fallback-design.md): when no ranked
 * non-planner executor declares a model at or above the task's target tier, and the planner's own
 * runner does, rank the planner first. The pace verdict and the planner reserve headroom do not
 * apply here; hard exclusions (disabled, unavailable, blocked, broken, not installed, signed out,
 * ineligible budget) still do. Mutates `ranked` and `excluded`.
 */
function applyPlannerTierFallback(s: Strategy, statuses: Record<string, ProviderStatus>, ranked: RankedEntry[], excluded: Excluded[], target: TierTargets["complex"] | undefined): void {
  if (target === undefined || s.pacing.plannerTierFallback === "off") return;
  const isPlanner = (id: string) => { const r = s.runners[id]; return !!r && isPlannerRunner(s, r); };
  if (ranked.some(e => !isPlanner(e.id) && declaresTier(s, e.id, target))) return;
  const plannerId = Object.keys(s.runners).find(isPlanner);
  if (!plannerId || !declaresTier(s, plannerId, target)) return;
  const runner = s.runners[plannerId], st = statuses[plannerId];
  if (!st || runner.enabled === false || !s.accounts[runner.account] || st.unavailableReason || st.blockedReason || st.brokenReason || !st.installed || st.signedOutReason) return;
  const decision = restrictEligibility(st.eligibility);
  if (decision.state === "ineligible") return;
  const why = `planner tier fallback: no ${target} executor available`;
  const at = ranked.findIndex(e => e.id === plannerId);
  const entry: RankedEntry = at >= 0 ? ranked.splice(at, 1)[0] : {
    id: plannerId, account: runner.account, eligibility: decision,
    ...(decision.state === "uncertain" ? { fallback: "uncertain" as const } : {}),
    score: 0, verdict: st.verdict, reason: why, unknown: decision.state === "uncertain", order: -1,
  };
  const gone = excluded.findIndex(e => e.id === plannerId);
  if (gone >= 0) excluded.splice(gone, 1);
  ranked.unshift({ ...entry, reason: why, tierFallback: { targetTier: target, reason: why },
    score: Math.max(0, ...ranked.map(e => e.score)) + 1 });
}

/**
 * Passing any explicit `CandidateSelection` into `rankExecutors` takes its `if (selection)` branch,
 * which sorts by array order alone and skips the `pacing.policy` ordering (priority promotion/
 * demotion, headroom/fill reordering) entirely — correct for a real project selection, which is a
 * curated order to respect verbatim, but not for widening a conversation's pool, which must keep
 * that ordering for every other candidate. So a conversation ranks with no selection override at
 * all (exactly like a delegated task with no project policy), and only afterward, if its requested
 * executor was left out of the routing pool entirely (e.g. the planner's own account, excluded by
 * every routing rule), is that one candidate ranked on its own — a lone selection trivially keeps
 * its own order — and appended as a last-resort fallback, never disturbing the real sort above it.
 * The runner and `dispatch.explain` both use this, so the preview matches the run.
 */
export function conversationFallback(
  ranking: ReturnType<typeof rankExecutors>, kind: string | null, s: Strategy,
  byId: Record<string, ProviderStatus>, requested: string | null,
): void {
  if (!requested || ranking.ranked.some(e => e.id === requested) || ranking.excluded.some(e => e.id === requested)) return;
  const solo = rankExecutors(kind, s, byId, { executors: [requested], order: "configured" }, { includePlanner: true });
  if (!solo.ranked.length) { ranking.excluded.push(...solo.excluded); return; }
  const floor = Math.min(1, ...ranking.ranked.map(e => e.score));
  ranking.ranked.push({ ...solo.ranked[0], score: floor - 1 });
  if (solo.uncertain?.length) (ranking.uncertain ??= []).push(...solo.uncertain);
}
