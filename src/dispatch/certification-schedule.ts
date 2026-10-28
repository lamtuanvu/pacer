import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { readJson } from "../fsutil";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";
import type { Strategy } from "../config/strategy";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { isPlannerRunner } from "../config/runner-id";
import { listRepos } from "../core/repos";
import { computeStatus, type Status } from "../engine/status";
import { startJob, listJobs } from "../jobs/registry";
import {
  resolveEnforcementTarget,
  certificateStatus,
  probeSupportReason,
  probeNativeControl,
  type EnforcementTarget,
  type CertificateStatus,
} from "./enforcement";

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
  mkdirSync(dirname(file(ctx)), { recursive: true, mode: 0o700 });
  writeFileSync(file(ctx), JSON.stringify(state), { mode: 0o600 });
}

/**
 * Applies the real outcome to an attempt `recordProbeOutcome` already counted,
 * so a probe is charged against the daily ceiling exactly once.
 */
export function settleProbe(
  state: ScheduleState, key: string, outcome: { certified: boolean; costPct: number | null },
): ScheduleState {
  const record = state.attempts[key];
  if (!record) return state;
  return { ...state, attempts: { ...state.attempts, [key]: {
    ...record,
    ...(outcome.certified ? { failures: 0, nextEligibleAt: 0, repoSwitches: 0 } : {}),
    lastCostPct: outcome.costPct,
  } } };
}

/**
 * Consent and probe outcomes live in one file and are written minutes apart by
 * different callers, so every read-modify-write takes the lock and re-reads.
 */
function withScheduleLock<T>(ctx: Ctx, update: (state: ScheduleState) => [ScheduleState, T]): Promise<T> {
  return withLock(ctx, "certification-schedule", async () => {
    const [next, result] = update(readScheduleState(ctx));
    writeScheduleState(ctx, next);
    return result;
  }, { timeoutMs: 10_000, staleMs: 30_000 });
}

export function recordConsent(ctx: Ctx, account: string, granted: boolean): Promise<"granted" | "declined"> {
  const answer = granted ? "granted" as const : "declined" as const;
  return withScheduleLock(ctx, state => [{ ...state, consent: { ...state.consent, [account]: answer } }, answer]);
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

/**
 * Dependencies for the certification tick. Inject fakes in tests to avoid
 * spending real account quota or launching real agents.
 */
export interface TickDeps {
  /**
   * Override the probe function. Default calls probeNativeControl,
   * which spends real quota and launches a real agent.
   */
  probe?: (ctx: Ctx, strategy: Strategy, runner: string, repo: string) => Promise<CertificateStatus>;
  /**
   * Override the status function. Default calls computeStatus.
   */
  status?: (ctx: Ctx, strategy: Strategy) => Promise<Status>;
  /**
   * Override the active repository. Default uses listRepos or cwd().
   * Useful in tests to avoid repo-specific control files affecting the result.
   */
  repo?: string;
}

function findPlannerRunner(s: Strategy): { id: string; account: string } | null {
  for (const [id, runner] of Object.entries(s.runners)) {
    if (isPlannerRunner(s, runner)) {
      return { id, account: runner.account };
    }
  }
  return null;
}

function isListedForRouting(s: Strategy, runnerId: string): boolean {
  for (const rule of s.routing) {
    if (rule.executors.includes(runnerId)) return true;
  }
  return false;
}

function getActiveRepo(ctx: Ctx): string {
  const repos = listRepos(ctx);
  if (repos.length > 0) return repos[0].path;
  return cwd();
}

/**
 * Returns the maximum usedPct across all of the planner account's non-stale
 * windows that carry a usedPct reading. Minimum headroom = maximum usedPct.
 * Returns null if no window has a usable reading.
 */
function plannerAccountUsedPct(status: Status, plannerAccount: string): number | null {
  const account = status.accounts?.find(a => a.name === plannerAccount);
  if (!account) return null;

  // Find providers belonging to this account and collect their window usedPct
  let maxUsed: number | null = null;

  // Check the account's binding window (existing behavior)
  if (account.usedPct !== null) {
    maxUsed = account.usedPct;
  }

  // Check all provider windows for this account
  for (const provider of status.providers) {
    if (provider.account !== plannerAccount) continue;
    for (const window of provider.windows) {
      if (window.stale || window.usedPct === null) continue;
      if (maxUsed === null || window.usedPct > maxUsed) {
        maxUsed = window.usedPct;
      }
    }
  }

  return maxUsed;
}

/**
 * Enforcement key: (runner, account, launchMode) matches how certificates
 * are keyed in the enforcement store.
 */
function enforcementKey(target: EnforcementTarget): string {
  return JSON.stringify([target.runner, target.account, target.launchMode]);
}

/**
 * Run one certification tick: decide whether to probe, run the probe if
 * warranted, record the outcome. Never throws.
 *
 * startJob returns immediately when a job daemon is registered (http service),
 * so we cannot rely on job.state after startJob returns. We capture the
 * result inside the run callback using a deferred promise, then await that
 * promise for the real completion.
 */
export async function tick(ctx: Ctx, deps: TickDeps = {}): Promise<void> {
  try {
    let strategy: Strategy;
    try {
      strategy = loadStrategy(ctx);
    } catch (e) {
      if (e instanceof MissingStrategyError) return;
      throw e;
    }

    const planner = findPlannerRunner(strategy);
    if (!planner) return;
    const runnerId = planner.id;
    const plannerAccount = planner.account;

    const repo = deps.repo ?? getActiveRepo(ctx);

    let target: EnforcementTarget;
    let unsupportedReason: string | null;
    let certificate: CertificateStatus;
    try {
      target = await resolveEnforcementTarget(ctx, strategy, runnerId, repo);
      unsupportedReason = probeSupportReason(target, repo);
      certificate = certificateStatus(ctx, target);
    } catch {
      return;
    }

    const probeFn = deps.probe ?? probeNativeControl;
    const statusFn = deps.status ?? ((c: Ctx, s: Strategy) => computeStatus(c, s));

    const statusBefore = await statusFn(ctx, strategy);
    const usedPctBefore = plannerAccountUsedPct(statusBefore, plannerAccount);
    const headroomPct = usedPctBefore !== null ? 100 - usedPctBefore : null;

    const state = readScheduleState(ctx);
    const key = enforcementKey(target);

    const inputs: ProbeInputs = {
      key,
      account: target.account,
      runner: target.runner,
      repo,
      certificate,
      unsupportedReason,
      headroomPct,
      reserveHeadroomPct: strategy.pacing.plannerReserveHeadroom,
      mode: strategy.pacing.plannerProbe,
      // pacing.planner_executes belongs to the planner-candidacy subsystem.
      // true is the interim value until that subsystem ships.
      plannerExecutes: true,
      listedForRouting: isListedForRouting(strategy, runnerId),
    };

    const decision = decideProbe(inputs, state, ctx.now);
    if (!decision.probe) {
      return;
    }

    const jobKind = "enforcement.probe" as const;
    const jobTarget = `${runnerId}:${repo}`;

    // Check for existing running job BEFORE starting
    const existingRunning = listJobs(ctx, { target: jobTarget })
      .find(j => j.kind === jobKind && j.state === "running");

    let certResult: CertificateStatus;
    let usedPctAfter: number | null = null;

    if (existingRunning) {
      // Dedupe: a probe is already running for this (runner, repo).
      // Do not record an outcome, do not increment backoff.
      return;
    }

    // Charge the probe against the daily ceiling and set a backoff BEFORE spending
    // anything. Everything after this point can fail, crash or be restarted, and
    // the quota is already gone; a brake recorded only on the success path is no
    // brake at all.
    await withScheduleLock(ctx, fresh =>
      [recordProbeOutcome(fresh, key, repo, { certified: false, costPct: null }, ctx.now), null]);

    // Deferred promise to capture the probe result from inside the callback.
    // Needed because startJob returns immediately when a daemon is registered.
    let probeSettle: (result: CertificateStatus) => void;
    const probeComplete = new Promise<CertificateStatus>(resolve => {
      probeSettle = resolve;
    });

    const job = await startJob(
      ctx,
      jobKind,
      jobTarget,
      ["Probe native child control"],
      async (step) => {
        step.start("Probe native child control");
        // Settle on every path: a throw that left this pending would hang the
        // await below, and with it the service's re-entrancy flag, for good.
        let result: CertificateStatus;
        try {
          result = await probeFn(ctx, strategy, runnerId, repo);
        } catch (e) {
          result = { state: "uncertified", reason: e instanceof Error ? e.message : String(e) };
        }
        probeSettle(result);
        if (result.state !== "certified") {
          throw new Error(result.reason ?? "Native child blocking was not observed");
        }
        step.pass("Probe native child control", "Native child blocking verified");
      },
    );

    // Await the actual probe completion through our deferred promise
    certResult = await probeComplete;

    // Read status AFTER probe completes for accurate cost measurement
    const statusAfter = await statusFn(ctx, strategy);
    usedPctAfter = plannerAccountUsedPct(statusAfter, plannerAccount);

    // Calculate cost: delta in usedPct. Null if either reading was unavailable.
    let costPct: number | null = null;
    if (usedPctBefore !== null && usedPctAfter !== null) {
      costPct = usedPctAfter - usedPctBefore;
    }

    // Record outcome and persist state
    const outcome = {
      certified: certResult.state === "certified",
      costPct,
    };
    // Re-read under the lock: the probe took minutes, and a consent answer given
    // in that window must survive this write rather than be reverted by it.
    await withScheduleLock(ctx, fresh => [settleProbe(fresh, key, outcome), null]);

  } catch {
    // tick() never throws
    return;
  }
}
