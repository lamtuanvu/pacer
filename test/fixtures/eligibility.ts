import type { EligibilityDecision } from "../../src/evidence/types";
/** Explicit decisions for consumer tests; evidence policy is covered separately. */
export function eligibility(state: EligibilityDecision["state"] = "eligible"): EligibilityDecision {
  return { state, reasons: state === "uncertain" ? [{ code: "budget_missing", evidenceIds: [] }] : [],
    evaluatedAt: 0, validUntil: null, evidenceAgeS: null, availability: "ready", budget: state === "uncertain" ? "unknown" : "permitted", spendingRisk: "unknown" };
}

export const exhaustedEligibility = (): EligibilityDecision => ({ ...eligibility("ineligible"), budget: "exhausted", reasons: [{ code: "budget_exhausted", evidenceIds: [] }] });
