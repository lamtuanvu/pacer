import type { UsageKind, UsageSource, UsageWindow } from "../types";

export interface EvidenceScope { account: string; identity: string; runner?: string; model?: string; host?: string }
export interface Evidence<T> {
  id: string;
  scope: EvidenceScope;
  source: UsageSource | "execution" | "configuration";
  observedAt: number | null;
  validUntil: number | null;
  reason: string;
  value: T;
}
export interface SpendingSignals {
  creditsAvailable: boolean | null;
  creditBalance: number | null;
  paidConsumption: "observed" | "not_observed" | "unknown";
}
export interface AccountEvidence {
  availability: Evidence<"ready" | "unavailable" | "unknown">[];
  budget: Evidence<UsageWindow>[];
  spending: Evidence<SpendingSignals>[];
}
export interface ReconciledEvidence { facts: AccountEvidence; conflicts: string[] }
export interface EligibilityInput {
  now: number;
  scope: EvidenceScope;
  usage: UsageKind;
  allowPaid: boolean;
  evidence: ReconciledEvidence;
  restrictions: { code: string; evidenceIds: string[] }[];
}
export interface EligibilityDecision {
  state: "eligible" | "uncertain" | "ineligible";
  reasons: { code: string; evidenceIds: string[] }[];
  evaluatedAt: number;
  validUntil: number | null;
  evidenceAgeS: number | null;
  availability: "ready" | "unavailable" | "unknown";
  budget: "permitted" | "exhausted" | "unknown" | "not_required";
  spendingRisk: "observed" | "unknown" | "not_observed";
}
