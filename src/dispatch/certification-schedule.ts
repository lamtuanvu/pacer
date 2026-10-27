import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import type { CertificateStatus } from "./enforcement";

export const MAX_PROBES_PER_DAY = 2;
export const BACKOFF_BASE_S = 900;
export const BACKOFF_MAX_S = 86_400;
export const MAX_REPO_SWITCHES = 3;
/** Observed account movement, in percentage points of the probed window. */
export const MAX_COST_PCT = 2;
const DAY_S = 86_400;

export interface AttemptRecord {
  failures: number; nextEligibleAt: number; lastRepo: string;
  repoSwitches: number; dayStartedAt: number; probesToday: number;
  lastCostPct: number | null;
}
export interface ScheduleState {
  consent: Record<string, "granted" | "declined">;
  attempts: Record<string, AttemptRecord>;
}
export interface ProbeInputs {
  key: string; account: string; runner: string; repo: string;
  certificate: CertificateStatus; unsupportedReason: string | null;
  headroomPct: number | null; reserveHeadroomPct: number;
  mode: "ask" | "auto" | "off"; plannerExecutes: boolean; listedForRouting: boolean;
}
export type ProbeDecision = { probe: true } | { probe: false; reason: string; needsConsent?: true };

const empty: AttemptRecord = {
  failures: 0, nextEligibleAt: 0, lastRepo: "", repoSwitches: 0,
  dayStartedAt: 0, probesToday: 0, lastCostPct: null,
};

const file = (ctx: Ctx) => join(ctx.pacerHome, "state", "certification-schedule.json");

export function readScheduleState(ctx: Ctx): ScheduleState {
  const stored = readJson<Partial<ScheduleState>>(file(ctx));
  return { consent: stored?.consent ?? {}, attempts: stored?.attempts ?? {} };
}

export function writeScheduleState(ctx: Ctx, state: ScheduleState): void {
  writeJsonAtomic(file(ctx), state);
}

/**
 * A clock that moved backwards must not leave a ceiling that never clears, so
 * `now` before the recorded start reopens the window rather than blocking.
 */
function dayWindow(record: AttemptRecord, now: number): { dayStartedAt: number; probesToday: number } {
  return now < record.dayStartedAt || now - record.dayStartedAt >= DAY_S
    ? { dayStartedAt: now, probesToday: 0 }
    : { dayStartedAt: record.dayStartedAt, probesToday: record.probesToday };
}

/**
 * Mostly a list of reasons not to probe: a probe spends the quota of the very
 * account it certifies, so every decline carries its own reason for display.
 */
export function decideProbe(inputs: ProbeInputs, state: ScheduleState, now: number): ProbeDecision {
  const no = (reason: string, needsConsent?: true): ProbeDecision =>
    needsConsent ? { probe: false, reason, needsConsent } : { probe: false, reason };
  if (!inputs.plannerExecutes) return no("planner execution is turned off");
  if (!inputs.listedForRouting) return no(`${inputs.runner} is not listed in a routing rule or project selection`);
  if (inputs.mode === "off") return no("certification probing is turned off");
  if (inputs.unsupportedReason) return no(inputs.unsupportedReason);
  if (inputs.certificate.state === "certified") return no("the certificate is current");

  const consent = state.consent[inputs.account];
  if (consent === "declined") return no(`certification probing was declined for ${inputs.account}`);
  if (inputs.mode === "ask" && consent !== "granted") {
    return no(`certification probing needs your consent for ${inputs.account}`, true);
  }

  const record = state.attempts[inputs.key] ?? empty;
  if (now < record.nextEligibleAt) return no("waiting out the backoff from an earlier failed probe");
  const { probesToday } = dayWindow(record, now);
  if (probesToday >= MAX_PROBES_PER_DAY) return no(`already probed ${probesToday} times today`);
  if (record.repoSwitches >= MAX_REPO_SWITCHES) {
    return no("the certificate keeps being invalidated by switching repositories");
  }
  if (record.lastCostPct !== null && record.lastCostPct > MAX_COST_PCT) {
    return no(`the last probe cost ${record.lastCostPct}% of the account window`);
  }
  if (inputs.headroomPct === null) return no("planner headroom is unknown");
  if (inputs.headroomPct <= inputs.reserveHeadroomPct) {
    return no(`planner reserve: ${inputs.headroomPct}% headroom is at or below the ${inputs.reserveHeadroomPct}% reserve`);
  }
  return { probe: true };
}

export function recordProbeOutcome(
  state: ScheduleState, key: string, repo: string,
  outcome: { certified: boolean; costPct: number | null }, now: number,
): ScheduleState {
  const previous = state.attempts[key];
  const record = previous ?? empty;
  const { dayStartedAt, probesToday } = dayWindow(record, now);
  const failures = outcome.certified ? 0 : record.failures + 1;
  const updated: AttemptRecord = {
    failures,
    nextEligibleAt: outcome.certified ? 0 : now + Math.min(BACKOFF_BASE_S * 2 ** (failures - 1), BACKOFF_MAX_S),
    lastRepo: repo,
    repoSwitches: previous && previous.lastRepo !== repo ? record.repoSwitches + 1 : record.repoSwitches,
    dayStartedAt,
    probesToday: probesToday + 1,
    lastCostPct: outcome.costPct,
  };
  return { consent: { ...state.consent }, attempts: { ...state.attempts, [key]: updated } };
}
