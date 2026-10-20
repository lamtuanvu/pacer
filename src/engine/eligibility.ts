import type { EligibilityDecision, EligibilityInput } from "../evidence/types";
import { appliesTo, currentEvidence, evidenceDeadline } from "./evidence";
import { EXHAUSTED_PCT } from "./verdict";

/** Execution permission is independent of pacing and never inferred from UNKNOWN. */
export function evaluateEligibility(input: EligibilityInput): EligibilityDecision {
  const { now, scope, usage, allowPaid } = input;
  const facts = input.evidence.facts;
  const availability = facts.availability.filter(f => appliesTo(f, scope));
  const budget = facts.budget.filter(f => appliesTo(f, scope));
  const spending = facts.spending.filter(f => appliesTo(f, scope));
  const liveAvailability = availability.filter(f => currentEvidence(f, now));
  const liveBudget = budget.filter(f => currentEvidence(f, now, evidenceDeadline(f)) && !f.value.stale);
  const liveSpending = spending.filter(f => currentEvidence(f, now));
  const all = [...availability, ...budget, ...spending];
  const conflict = all.filter(f => input.evidence.conflicts.includes(f.id));
  const unavailable = liveAvailability.filter(f => f.value === "unavailable");
  const exhausted = liveBudget.filter(f => f.value.usedPct !== null && f.value.usedPct >= EXHAUSTED_PCT);
  const noBudgetRequired = usage === "reactive" || usage === "unmetered";
  const unknownBudget = !noBudgetRequired && (!budget.length || liveBudget.length !== budget.length || liveBudget.some(f => f.value.usedPct === null));
  const deadlines = [...availability.map(f => f.validUntil), ...budget.map(evidenceDeadline)].filter((v): v is number => v !== null && v > now);
  const times = all.map(f => f.observedAt).filter((v): v is number => v !== null && v <= now);
  const decision: EligibilityDecision = {
    state: "eligible", reasons: [], evaluatedAt: now,
    validUntil: deadlines.length ? Math.min(...deadlines) : null,
    evidenceAgeS: times.length ? Math.max(0, now - Math.min(...times)) : null,
    availability: unavailable.length ? "unavailable" : liveAvailability.some(f => f.value === "ready") ? "ready" : "unknown",
    budget: exhausted.length ? "exhausted" : unknownBudget ? "unknown" : noBudgetRequired ? "not_required" : "permitted",
    spendingRisk: liveSpending.some(f => f.value.paidConsumption === "observed") ? "observed"
      : liveSpending.length && liveSpending.every(f => f.value.paidConsumption === "not_observed") ? "not_observed" : "unknown",
  };
  decision.reasons.push(...input.restrictions);
  for (const fact of unavailable) decision.reasons.push({ code: fact.reason, evidenceIds: [fact.id] });
  if (exhausted.length && !allowPaid) decision.reasons.push({ code: "budget_exhausted", evidenceIds: exhausted.map(f => f.id) });
  if (decision.reasons.length) decision.state = "ineligible";
  else {
    if (conflict.length) decision.reasons.push({ code: "evidence_conflicting", evidenceIds: conflict.map(f => f.id) });
    if (decision.availability === "unknown") decision.reasons.push({ code: "availability_unknown", evidenceIds: availability.map(f => f.id) });
    if (unknownBudget) decision.reasons.push({ code: budget.length ? "budget_expired_or_unknown" : "budget_missing", evidenceIds: budget.map(f => f.id) });
    if (decision.reasons.length) decision.state = "uncertain";
  }
  return decision;
}
