import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { Ctx, UsageWindow } from "../types";
import type { EligibilityDecision, Evidence } from "../evidence/types";
import { limitObservation, readMarks } from "../usage/reactive";
import { accountEvidenceScope, readEvidence } from "../core/evidence";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../engine/evidence";
import { evaluateEligibility } from "../engine/eligibility";
import { EXHAUSTED_PCT } from "../engine/verdict";
import { readBlocked } from "./blocked";
import { LIMIT_WINDOW_LENGTH_S } from "../usage/freshness";

export type ExecutorGuardReason = "Blocked by you" | "exhausted";

/** Budget / block late-guard result shared by the runner and planner pacing. */
export interface ExecutorGuard {
  reason: ExecutorGuardReason;
  until?: number;
  decision?: EligibilityDecision;
}

/** Cap how far ahead a quota reset can schedule a wake (evidence may be shorter-lived). */
const GUARD_RESET_CAP_S = 7 * 24 * 3600;

/** Prefer the latest exhausted-window resetsAt (capped) over evidence freshness (validUntil). */
function exhaustedUntil(ctx: Ctx, evidenceBudget: Evidence<UsageWindow>[], decision: EligibilityDecision): number | undefined {
  const cap = ctx.now + GUARD_RESET_CAP_S;
  let latest: number | undefined;
  for (const fact of evidenceBudget) {
    const { usedPct, resetsAt } = fact.value;
    if (usedPct === null || usedPct < EXHAUSTED_PCT || resetsAt === null || resetsAt <= ctx.now) continue;
    const capped = Math.min(resetsAt, cap);
    latest = latest === undefined ? capped : Math.max(latest, capped);
  }
  return latest ?? decision.validUntil ?? undefined;
}

/** Re-read local guardrails without provider I/O or a second eligibility policy. */
export function executorGuard(ctx: Ctx, s: Strategy | undefined, id: string): ExecutorGuard | undefined {
  const runner = s ? resolveRunner(s, id) : null;
  const parsed = parseRunnerId(id);
  const accountName = runner?.account ?? parsed?.account ?? parsed?.agent;
  const matches = (key: string) => key === id || key === accountName || (!!s && !!runner && resolveRunner(s, key)?.id === runner.id);
  const blocked = Object.entries(readBlocked(ctx)).find(([key]) => matches(key));
  if (blocked) {
    return { reason: "Blocked by you", ...(blocked[1].until != null ? { until: blocked[1].until } : {}) };
  }
  const limits = Object.keys(readMarks(ctx)).filter(matches).flatMap(key => {
    const observation = limitObservation(ctx, key);
    return observation ? [observation] : [];
  });
  const account = s && runner ? s.accounts[runner.account] : undefined;
  // Without an account identity, only an explicit operator restriction is known.
  if (!s || !runner || !account) {
    const manual = limits.find(limit => limit.manual);
    return manual ? { reason: "exhausted", until: manual.until } : undefined;
  }
  const scope = accountEvidenceScope(account, s.hosts);
  const snapshot = readEvidence(ctx, scope), incoming = emptyEvidence();
  for (const limit of limits) {
    if (!limit.manual && (limit.scope?.identity !== scope.identity
      || snapshot.retiredAt !== undefined && (limit.observedAt === null || limit.observedAt <= snapshot.retiredAt))) continue;
    incoming.budget.push(evidenceFact(limit.scope ?? scope, limit.manual ? "configuration" : "execution",
      limit.observedAt, limit.until, "quota_failure",
      { name: "limit", usedPct: 100, resetsAt: limit.until, lengthS: LIMIT_WINDOW_LENGTH_S, paced: false }));
  }
  const budgetPolicy = JSON.stringify([account.weeklyUsd, account.weeklyTokens]);
  const evidence = reconcileEvidence(snapshot.evidence.facts, incoming, ctx.now, budgetPolicy);
  evidence.facts.budget = evidence.facts.budget.filter(f => f.source !== "metered" || f.budgetPolicy === budgetPolicy);
  const decision = evaluateEligibility({ now: ctx.now,
    scope: { ...scope, runner: runner.id, model: runner.model ?? "default", host: runner.host ?? "local" },
    usage: account.usage, allowPaid: account.allowPaid, evidence, restrictions: [] });
  if (!decision.reasons.some(reason => reason.code === "budget_exhausted")) return undefined;
  const until = exhaustedUntil(ctx, evidence.facts.budget, decision);
  return {
    reason: "exhausted",
    ...(until !== undefined ? { until } : {}),
    decision,
  };
}

/** Re-read local guardrails without provider I/O or a second eligibility policy. */
export function executorExclusion(ctx: Ctx, s: Strategy | undefined, id: string): string | undefined {
  return executorGuard(ctx, s, id)?.reason;
}

/** Late-guard / ranking reasons that refuse a requested executor immediately. */
export const REQUESTED_EXECUTOR_BUDGET_REFUSAL = /Blocked by you|exhausted/;

/** finish() prefixes CoreError messages with "pacer runner error:" — anchor there to avoid misclassifying quoted agent text. */
const REQUESTED_EXECUTOR_UNAVAILABLE = /^pacer runner error: requested executor "[^"]+" is unavailable \((.+)\)/;

/** True when a task report is the runner's requested-executor refusal for budget exhaustion or a user block. */
export function isRequestedExecutorBudgetRefusal(report: string | null | undefined): boolean {
  if (!report) return false;
  const match = REQUESTED_EXECUTOR_UNAVAILABLE.exec(report);
  return !!match && REQUESTED_EXECUTOR_BUDGET_REFUSAL.test(match[1]!);
}
