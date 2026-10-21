import { parseRunnerId, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import type { Ctx } from "../types";
import { limitObservation, readMarks } from "../usage/reactive";
import { accountEvidenceScope, readEvidence } from "../core/evidence";
import { emptyEvidence, evidenceFact, reconcileEvidence } from "../engine/evidence";
import { evaluateEligibility } from "../engine/eligibility";
import { readBlocked } from "./blocked";

/** Re-read local guardrails without provider I/O or a second eligibility policy. */
export function executorExclusion(ctx: Ctx, s: Strategy | undefined, id: string): string | undefined {
  const runner = s ? resolveRunner(s, id) : null;
  const parsed = parseRunnerId(id);
  const accountName = runner?.account ?? parsed?.account ?? parsed?.agent;
  const matches = (key: string) => key === id || key === accountName || (!!s && !!runner && resolveRunner(s, key)?.id === runner.id);
  if (Object.keys(readBlocked(ctx)).some(matches)) return "Blocked by you";
  const limits = Object.keys(readMarks(ctx)).filter(matches).flatMap(key => {
    const observation = limitObservation(ctx, key);
    return observation ? [observation] : [];
  });
  const account = s && runner ? s.accounts[runner.account] : undefined;
  // Without an account identity, only an explicit operator restriction is known.
  if (!s || !runner || !account) return limits.some(limit => limit.manual) ? "exhausted" : undefined;
  const scope = accountEvidenceScope(account, s.hosts);
  const snapshot = readEvidence(ctx, scope), incoming = emptyEvidence();
  for (const limit of limits) {
    if (!limit.manual && (limit.scope?.identity !== scope.identity
      || snapshot.retiredAt !== undefined && (limit.observedAt === null || limit.observedAt <= snapshot.retiredAt))) continue;
    incoming.budget.push(evidenceFact(limit.scope ?? scope, limit.manual ? "configuration" : "execution",
      limit.observedAt, limit.until, "quota_failure",
      { name: "limit", usedPct: 100, resetsAt: limit.until, lengthS: 21600, paced: false }));
  }
  const budgetPolicy = JSON.stringify([account.weeklyUsd, account.weeklyTokens]);
  const evidence = reconcileEvidence(snapshot.evidence.facts, incoming, ctx.now, budgetPolicy);
  evidence.facts.budget = evidence.facts.budget.filter(f => f.source !== "metered" || f.budgetPolicy === budgetPolicy);
  const decision = evaluateEligibility({ now: ctx.now,
    scope: { ...scope, runner: runner.id, model: runner.model ?? "default", host: runner.host ?? "local" },
    usage: account.usage, allowPaid: account.allowPaid, evidence, restrictions: [] });
  return decision.reasons.some(reason => reason.code === "budget_exhausted") ? "exhausted" : undefined;
}
