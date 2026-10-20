import type { EligibilityDecision } from "../evidence/types";
import type { StatusTone } from "./words";

const reasons: Record<string, string> = {
  budget_exhausted: "Budget exhausted; paid execution is not allowed",
  budget_missing: "No budget observation is available",
  budget_expired_or_unknown: "Budget evidence has expired or is incomplete",
  evidence_conflicting: "Current observations disagree",
  evidence_missing: "Execution evidence is missing",
  availability_unknown: "Executor availability is not confirmed",
  subscription_missing: "No active subscription",
  subscription_failed: "Subscription is unavailable",
  subscription_response_invalid: "Subscription status could not be read",
  authentication_failed: "Sign-in is required",
  refresh_failed: "Could not refresh execution evidence",
  disabled: "Disabled", not_installed: "Not installed", signed_out: "Sign-in is required",
  blocked: "Blocked by you", broken: "Executor is not working", unavailable: "Executor is unavailable",
  planner: "Reserved for planning", not_configured: "Not configured", quota_failure: "The executor reported a quota limit",
};
export function eligibilityPresentation(decision: EligibilityDecision | undefined, now: number): {
  label: string; tone: StatusTone; detail: string; age: string | null; glyph: string;
} {
  if (!decision) return { label: "Eligibility unknown", tone: "neutral", detail: "No execution decision is available", age: null, glyph: "?" };
  const ageS = decision.evidenceAgeS === null ? null : Math.max(0, decision.evidenceAgeS + now - decision.evaluatedAt);
  const age = ageS === null ? null : `observed ${ageS < 60 ? `${Math.floor(ageS)}s` : ageS < 3600 ? `${Math.floor(ageS / 60)}m` : `${Math.floor(ageS / 3600)}h`} ago`;
  const detail = decision.reasons.map(reason => reasons[reason.code] ?? "Execution evidence needs attention").join("; ");
  if (decision.state === "ineligible") return { label: "Unavailable", tone: "bad", detail, age, glyph: "!" };
  if (decision.state === "uncertain") return { label: "Uncertain fallback", tone: "warn", detail, age, glyph: "?" };
  return { label: "Eligible", tone: "good", detail: decision.budget === "exhausted" ? "Paid execution allowed" : "Execution permitted", age, glyph: "✓" };
}
