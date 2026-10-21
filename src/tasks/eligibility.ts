import type { EligibilityDecision, EvidenceScope } from "../evidence/types";
import type { Ctx } from "../types";
import type { Strategy } from "../config/strategy";
import { computeStatus, type Status } from "../engine/status";
import { accountEvidenceScope, evidenceRevision } from "../core/evidence";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import { usageRefreshCapability } from "../usage";
import { CoreError } from "../core/errors";

export interface LaunchEvidence {
  decision: EligibilityDecision;
  revision: number | null;
  identity: string;
  scope: EvidenceScope;
  runner: string;
  status: Status;
}
export async function prepareLaunch(ctx: Ctx, s: Strategy, runnerId: string, status: typeof computeStatus | ((ctx: Ctx, s: Strategy, opts?: Parameters<typeof computeStatus>[2]) => Promise<Status>) = computeStatus, previous?: Status): Promise<LaunchEvidence> {
  const runner = s.runners[runnerId], account = runner && s.accounts[runner.account];
  if (!runner || !account) throw new CoreError("conflict", "Selected executor is no longer configured");
  const scope = accountEvidenceScope(account, s.hosts);
  const st = await status(ctx, s, { refreshAccounts: usageRefreshCapability(account) === "unavailable" ? [] : [account.name] }).catch(error => {
    if (!previous) throw error;
    return { ...previous, providers: previous.providers.map(p => ({ ...p, eligibility: p.eligibility?.state === "ineligible"
      && (p.eligibility.validUntil === null || p.eligibility.validUntil > ctx.now) ? p.eligibility : {
        state: "uncertain" as const, reasons: [{ code: "refresh_failed", evidenceIds: [] }], evaluatedAt: ctx.now,
        validUntil: null, evidenceAgeS: p.eligibility?.evidenceAgeS ?? null,
        availability: "unknown" as const, budget: "unknown" as const, spendingRisk: "unknown" as const,
      } })) };
  });
  const provider = st.providers.find(p => p.id === runnerId);
  const decision: EligibilityDecision = provider?.eligibility ?? {
    state: "uncertain", reasons: [{ code: "evidence_missing", evidenceIds: [] }], evaluatedAt: ctx.now,
    validUntil: null, evidenceAgeS: null, availability: "unknown", budget: "unknown", spendingRisk: "unknown",
  };
  return { decision, revision: provider?.evidenceRevision ?? null, identity: scope.identity, scope, runner: runnerId, status: st };
}
/** Local-only check: no provider I/O while a launch reservation is held. */
export function launchEvidenceCurrent(ctx: Ctx, prepared: LaunchEvidence): boolean {
  return (prepared.decision.validUntil === null || prepared.decision.validUntil > ctx.now)
    && (prepared.revision === null || evidenceRevision(ctx, prepared.scope) === prepared.revision)
    && !readBlocked(ctx)[prepared.runner] && !readBroken(ctx)[prepared.runner];
}
