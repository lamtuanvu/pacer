import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { Ctx } from "../types";
import type { EligibilityDecision } from "../evidence/types";
import { limitObservation, readMarks } from "../usage/reactive";
import { accountEvidenceScope, readEvidence } from "../core/evidence";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../engine/evidence";
import { evaluateEligibility } from "../engine/eligibility";
import { readBlocked } from "./blocked";
import { LIMIT_WINDOW_LENGTH_S } from "../usage/freshness";

export type ExecutorGuardReason = "Blocked by you" | "exhausted";

/** Budget / block late-guard result shared by the runner and planner pacing. */
export interface ExecutorGuard {
  reason: ExecutorGuardReason;
  until?: number;
  decision?: EligibilityDecision;
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
  return {
    reason: "exhausted",
    ...(decision.validUntil != null ? { until: decision.validUntil } : {}),
    decision,
  };
}

/** Re-read local guardrails without provider I/O or a second eligibility policy. */
export function executorExclusion(ctx: Ctx, s: Strategy | undefined, id: string): string | undefined {
  return executorGuard(ctx, s, id)?.reason;
}

/** Late-guard / ranking reasons that refuse a requested executor immediately. */
export const REQUESTED_EXECUTOR_BUDGET_REFUSAL = /Blocked by you|exhausted/;

/**
 * True when a task report is the runner's requested-executor refusal for
 * budget exhaustion or a user block (same reasons as the late guard).
 */
export function isRequestedExecutorBudgetRefusal(report: string | null | undefined): boolean {
  if (!report) return false;
  const match = /requested executor "[^"]+" is unavailable \((.+)\)/.exec(report);
  return !!match && REQUESTED_EXECUTOR_BUDGET_REFUSAL.test(match[1]!);
}
