import { policySummary } from "../plugins/policy";
import { authObservation } from "../usage/auth";
import type { EligibilityDecision, EvidenceScope, ReconciledEvidence } from "../evidence/types";
import { accountEvidenceScope, mergeEvidence } from "../core/evidence";
import { appliesTo, currentEvidence, evidenceDeadline, evidenceFact, readingEvidence } from "./evidence";
import { evaluateEligibility } from "./eligibility";
import { statusTimer } from "../usage/trace";
import { accountSignIn } from "../usage/signin";
import { readPause, type PauseState } from "../core/pause";
import { readHold, type ModeHold } from "../core/mode-hold";
import { readEndpointState } from "../endpoints/state";
import { endpointRow } from "../endpoints/row";
import { orcaAccountHome } from "../orca/accounts";
import { parseRunnerId, formatRunnerId, runnerDefaults, resolveRunner } from "../config/runner-id";
import type { AccountCfg, RunnerCfg } from "../config/accounts";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import type { ProviderCfg, Strategy } from "../config/strategy";
import { type ActivityProfile, loadActivity } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { BlockedRunner, Ctx, UsageFigure, UsageFreshness, UsageKind, UsageLimit, UsageReading, UsageSource, UsageState, Verdict } from "../types";
import { markFreshness, AUTH_LIFETIME_S, LIMIT_WINDOW_LENGTH_S } from "../usage/freshness";
import { readAccountUsage } from "../usage/index";
import { cachedLoginPath, onPath } from "../exec/login-env";
import { activeLimitObservations, type LimitObservation } from "../usage/reactive";
import { type Mode, statusMode } from "./mode";
import { type Excluded, type ProviderStatus, type RankedExecutor, rankExecutors } from "./rank";
import { bindingWindow, evaluateWindow, type WindowStatus } from "./verdict";

export interface AccountStatus {
  eligibility?: EligibilityDecision;
  evidence?: ReconciledEvidence;
  name: string;
  kind: AccountCfg["kind"];
  verdict: Verdict;
  usedPct: number | null;
  pacePct: number | null;
  resetsAt: number | null;
  window: string | null;
  stale: boolean;
  source: UsageSource | null;
  remoteHost?: string;
  capturedAt: number | null;
  runners: string[];
  spendUsd: number | null;
  /** Additive: the account's one usage record (ADR 0030). Named `usageState` because `usage` is already this row's UsageKind. */
  usageState?: UsageState;
}

export interface Status {
  policy?: import("../view-model/words").PolicySummary;
  generatedAt: number;
  strategy: string;
  planner: string;
  mode: Mode;
  disabled: boolean;
  paused?: PauseState | null;
  modeHold?: ModeHold | null;
  calendarPace: boolean;
  warnings?: string[];
  accounts?: AccountStatus[];
  providers: ProviderStatus[];
  executors: { ranked: RankedExecutor[]; excluded: Excluded[] };
}

/** The computeStatus parts native status ops compose with (`_internal.status-broker.parts`). */
export const statusBrokerParts = (status: Status) => ({
  accounts: status.accounts, providers: status.providers, policy: status.policy, calendarPace: status.calendarPace,
  ...(status.warnings ? { warnings: status.warnings } : {}),
});

const BINARIES: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", agy: "agy" };

export function binaryFor(cfg: ProviderCfg): string {
  return cfg.via === "opencode" ? "opencode" : BINARIES[parseRunnerId(cfg.id)?.agent ?? cfg.id] ?? cfg.id;
}

export { displayName } from "../render/accounts";

/** The active limit behind the record: the covering mark/fact with the latest end. */
function pickLimit(facts: { source: import("../evidence/types").Evidence<unknown>["source"]; observedAt: number | null; validUntil: number | null; value: { resetsAt: number | null } }[]): UsageLimit | null {
  const withEnd = facts.filter(f => (f.validUntil ?? f.value.resetsAt) !== null);
  if (!withEnd.length) return null;
  const best = withEnd.reduce((a, b) =>
    ((b.validUntil ?? b.value.resetsAt)! > (a.validUntil ?? a.value.resetsAt)! ? b : a));
  return { until: (best.validUntil ?? best.value.resetsAt)!, observedAt: best.observedAt, manual: best.source === "configuration" };
}

/** A limit mark makes the record quote 100% over "limit" until the mark ends. */
function figureOf(limit: UsageLimit | null, binding: WindowStatus | null): UsageFigure | null {
  if (limit) return { usedPct: 100, window: "limit", lengthS: LIMIT_WINDOW_LENGTH_S, resetsAt: limit.until };
  if (binding && binding.usedPct !== null && Number.isFinite(binding.usedPct))
    return { usedPct: binding.usedPct, window: binding.name, lengthS: binding.lengthS, resetsAt: binding.resetsAt };
  return null;
}

/** Stale or failed readings are history for the whole record, not a number. */
function freshnessOf(reading: { error?: string; stale: boolean }, binding: WindowStatus | null, windows: WindowStatus[]): UsageFreshness {
  return reading.error || reading.stale || binding?.stale ? "historical" : windows.length ? "fresh" : "unknown";
}

/** The binding fact's time. Reactive and unmetered records observe only an active limit (D2);
 *  measured records use the eligibility age (newest budget fact, else newest availability fact). */
function observedAtOf(usage: string, limit: UsageLimit | null, eligibility: import("../evidence/types").EligibilityDecision, now: number): number | null {
  if (usage === "reactive" || usage === "unmetered") return limit?.observedAt ?? null;
  return eligibility.evidenceAgeS === null ? null : now - eligibility.evidenceAgeS;
}

/** Models the runner's tiers can select (its declared inventory, else its configured model). */
function selectableModels(runner: RunnerCfg): Set<string> {
  return new Set(runner.models?.length ? runner.models.map(m => m.id) : runner.model ? [runner.model] : []);
}

/**
 * Runners of the account that cannot take work now: an active limit or an
 * authentication/subscription failure on their configured model, plus facts
 * recorded for another model the runner's tiers can select (kept at that model,
 * never widened to the runner). Auth facts block but never change a verdict.
 */
function blockedRunnersOf(accountScope: EvidenceScope, runners: RunnerCfg[], snapshot: { evidence: ReconciledEvidence }, now: number, hostOf: (r: RunnerCfg) => string): BlockedRunner[] {
  const entries = new Map<string, BlockedRunner>();
  const add = (entry: BlockedRunner) => {
    const key = `${entry.runner}\u0000${entry.model}`;
    const previous = entries.get(key);
    // Quota failures have an end; keep the longest, and prefer them over auth blocks.
    if (!previous || (entry.reason === "quota_failure" && (previous.reason !== "quota_failure"
      || (previous.until ?? -Infinity) < (entry.until ?? -Infinity)))) entries.set(key, entry);
  };
  for (const runner of runners) {
    const model = runner.model ?? "default";
    const base = { account: accountScope.account, identity: accountScope.identity, runner: runner.name, host: hostOf(runner) };
    const selectable = selectableModels(runner);
    for (const fact of snapshot.evidence.facts.budget) {
      if (fact.value.name !== "limit" || fact.value.resetsAt === null) continue;
      const until = fact.validUntil ?? fact.value.resetsAt;
      if (appliesTo(fact, { ...base, model })) add({ runner: runner.name, model, until, reason: "quota_failure" });
      // A fact recorded for another model stays at that model, and only when the runner's
      // tiers can actually select it and the fact is really this account's (appliesTo's
      // account/identity check).
      else if (fact.scope.runner === runner.name && fact.scope.model && fact.scope.model !== model
        && selectable.has(fact.scope.model) && (!fact.scope.host || fact.scope.host === base.host)
        && fact.scope.account === base.account && fact.scope.identity === base.identity)
        add({ runner: runner.name, model: fact.scope.model, until, reason: "quota_failure" });
    }
    for (const fact of snapshot.evidence.facts.availability) {
      if (fact.value !== "unavailable" || !(fact.reason === "authentication_failed" || fact.reason === "subscription_missing")
        || !currentEvidence(fact, now)) continue;
      if (appliesTo(fact, { ...base, model })) add({ runner: runner.name, model, until: null, reason: fact.reason });
      else if (fact.scope.runner === runner.name && fact.scope.model && fact.scope.model !== model
        && selectable.has(fact.scope.model) && (!fact.scope.host || fact.scope.host === base.host)
        && fact.scope.account === base.account && fact.scope.identity === base.identity)
        add({ runner: runner.name, model: fact.scope.model, until: null, reason: fact.reason });
    }
  }
  return [...entries.values()];
}

export async function computeStatus(
  ctx: Ctx, s: Strategy, opts: { includePlannerSignIn?: boolean; cacheOnly?: boolean; servicePath?: boolean; profile?: ActivityProfile | null; readings?: Map<string, UsageReading>; refreshAccounts?: readonly string[] } = {},
): Promise<Status & { accounts: AccountStatus[] }> {
  const trace = statusTimer(ctx);
  const warnings = Object.values(s.accounts).filter(a => a.usageSource === "orca")
    .map(a => `account ${a.name}: usage_source orca is no longer read; using ${a.kind === "claude" || a.kind === "codex" ? "native" : "reactive"}`);
  const blocked = Object.fromEntries(Object.entries(readBlocked(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
  const broken = Object.fromEntries(Object.entries(readBroken(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
  // Active limit marks, keyed by the exhausted.json key they were recorded under, so marks
  // written under an alias or agent id match the same way executorExclusion matches them.
  const marks = activeLimitObservations(ctx);
  const profile = opts.profile !== undefined ? opts.profile : await loadActivity(ctx).catch(() => null);
  trace("activity");
  // Evaluate an account once; every runner draws on this same budget.
  const budgets = await Promise.all(Object.values(s.accounts).map(async (account) => {
    const runners = Object.values(s.runners).filter(r => r.account === account.name);
    const key = JSON.stringify({ account, models: [...new Set(runners.map(r => r.model))] });
    const reading = opts.readings?.get(account.name) ?? opts.readings?.get(key)
      ?? await readAccountUsage(ctx, account, runners, opts.refreshAccounts?.includes(account.name) ?? false, opts.cacheOnly, s.hosts).catch((e): UsageReading => ({
        windows: [], capturedAt: null, stale: false, error: String(e),
      }));
    opts.readings?.set(key, reading);
    const th = {
      ahead: s.pacing.aheadThreshold,
      behind: s.pacing.behindThreshold,
      paceScale: account.name === s.planner.account ? 1 - s.pacing.plannerReserve / 100 : 1,
    };
    // Account marks constrain all runners; runner marks (by id, alias or any key that resolves
    // to the runner) and other-model execution facts keep their actual scope.
    const limits: LimitObservation[] = [
      ...marks.filter(m => m.key === account.name).map(m => m.observation),
      ...runners.flatMap(r => marks.filter(m => m.key !== account.name
        && (m.key === r.name || resolveRunner(s, m.key)?.id === r.name)).map(m => m.observation)),
    ];
    const usage = reading.source === "reactive" ? "reactive" : account.usage;
    const fresh = markFreshness(reading, ctx.now);
    const scope = accountEvidenceScope(account, s.hosts);
    const incoming = readingEvidence(scope, reading, usage);
    // Percentages derived from a previous cap remain history, not current constraints.
    const budgetPolicy = JSON.stringify([account.weeklyUsd, account.weeklyTokens]);
    incoming.budget = incoming.budget.map(f => f.source === "metered"
      ? evidenceFact(f.scope, f.source, f.observedAt, f.validUntil, f.reason, f.value, budgetPolicy) : f);
    const auth = authObservation(ctx, scope);
    if (auth) incoming.availability.push(evidenceFact(auth.scope, "execution", auth.at, auth.at + AUTH_LIFETIME_S, "authentication_failed", "unavailable"));
    for (const runner of runners.filter(r => r.host === null && (opts.includePlannerSignIn || !(r.agent === s.planner.agent && r.account === s.planner.account)))) {
      const runnerScope = { ...scope, runner: runner.name, model: runner.model ?? "default", host: "local" };
      const signIn = accountSignIn(ctx, account, runnerScope);
      // A newer local login repairs only matching authentication facts, never quota or remote evidence.
      for (const recoveredScope of signIn.recoveredScopes ?? []) {
        incoming.availability.push(evidenceFact(recoveredScope, "session-log",
          signIn.recoveredAt!, signIn.recoveredAt! + AUTH_LIFETIME_S, "signin_observed", "ready"));
      }
    }
    for (const limit of limits.filter(v => v.manual || v.scope?.identity === scope.identity)) incoming.budget.push(evidenceFact(limit.scope ?? scope, limit.manual ? "configuration" : "execution", limit.observedAt,
      limit.until, "quota_failure", { name: "limit", usedPct: 100, resetsAt: limit.until, lengthS: LIMIT_WINDOW_LENGTH_S, paced: false }));
    const snapshot = await mergeEvidence(ctx, scope, incoming, budgetPolicy);
    snapshot.evidence = {
      ...snapshot.evidence,
      facts: {...snapshot.evidence.facts, budget: snapshot.evidence.facts.budget.filter(f =>
        f.source !== "metered" || f.budgetPolicy === budgetPolicy)},
    };
    const applicableIds = new Set(Object.values(snapshot.evidence.facts).flat().map(f => f.id));
    snapshot.evidence.conflicts = snapshot.evidence.conflicts.filter(id => applicableIds.has(id));
    const usageWindows = snapshot.evidence.facts.budget.filter(f => appliesTo(f, scope)).map(f => ({ ...f.value,
      stale: f.value.stale || !currentEvidence(f, ctx.now, evidenceDeadline(f)) }));
    const windows = usageWindows.map(w => evaluateWindow(w, ctx.now, profile, th));
    const live = windows.filter(w => !w.stale);
    const binding = bindingWindow(live) ?? bindingWindow(windows);
    const bindingFact = snapshot.evidence.facts.budget.find(f => f.value.name === binding?.name);
    const reconciledReading = { ...fresh, windows: usageWindows,
      stale: fresh.stale || usageWindows.some(w => w.stale),
      ...(bindingFact ? { capturedAt: bindingFact.observedAt,
        ...(!["execution", "configuration"].includes(bindingFact.source) ? { source: bindingFact.source as UsageSource } : {}) } : {}),
    };
    // Nothing to pace against: unmetered usage, or metered usage with no token budget and no dollar cap (spend is
    // still reported). Unmetered records are UNMETERED; such accounts are otherwise available rather than unknown,
    // so routing does not rank them last.
    const unlimited = usage === "unmetered" || usage === "reactive" || account.usage === "metered" && account.weeklyUsd === null && account.weeklyTokens === null;
    const verdict: Verdict = usage === "unmetered" && !windows.length ? "UNMETERED" : unlimited && !windows.length ? "OK" : live.length ? binding?.verdict ?? "UNKNOWN" : "UNKNOWN";
    const endpoint = opts.cacheOnly ? (account.connection || account.source === "opencode" ? readEndpointState(ctx, account.name) : {}) : await endpointRow(ctx, account);
    const endpointReason = endpoint.state === "key_missing" ? "Key missing" : endpoint.state === "not_working" ? `Not working · ${endpoint.detail ?? "test task failed"}` : undefined;
    const eligibility = evaluateEligibility({ now: ctx.now, scope, usage, budgetRequired: !unlimited, allowPaid: account.allowPaid,
      evidence: snapshot.evidence, restrictions: [] });
    // A stale or failed reading is history for the account record too (D7); evaluated once here.
    const accountEligibility: import("../evidence/types").EligibilityDecision = (reading.error || reading.stale) && eligibility.state === "eligible"
      ? { ...eligibility, state: "uncertain" as const, reasons: [{ code: "refresh_failed", evidenceIds: [] }] } : eligibility;
    return { account, runners, reading: reconciledReading, windows, binding, verdict, endpointReason, endpointNotTested: endpoint.state === "not_tested", scope, snapshot, eligibility: accountEligibility, usage, unlimited };
  }));
  trace("budgets");
  const byAccount = Object.fromEntries(budgets.map(b => [b.account.name, b]));
  // The PATH a local run would use: the login shell's once read (never waited on here), else the service's.
  // Strict work (the caller passes `servicePath`) runs with the service's environment, and its certification checks
  // the binary there.
  const loginPath = opts.servicePath ? undefined : cachedLoginPath(ctx.env, ctx.home);
  const installed = (bin: string) => loginPath !== undefined ? onPath({PATH: loginPath}, bin) !== null : ctx.which(bin) !== null;
  const providers: ProviderStatus[] = Object.values(s.runners).map(runner => {
    const { account, reading, endpointReason, endpointNotTested, scope, snapshot, usage, unlimited } = byAccount[runner.account];
    const runnerScope = { ...scope, runner: runner.name, model: runner.model ?? "default", host: runner.host ?? "local" };
    const windows = snapshot.evidence.facts.budget.filter(f => appliesTo(f, runnerScope)).map(f => evaluateWindow({ ...f.value,
      stale: f.value.stale || !currentEvidence(f, ctx.now, evidenceDeadline(f)) }, ctx.now, profile, {
        ahead: s.pacing.aheadThreshold, behind: s.pacing.behindThreshold,
        paceScale: account.name === s.planner.account ? 1 - s.pacing.plannerReserve / 100 : 1,
      }));
    const live = windows.filter(w => !w.stale), binding = bindingWindow(live) ?? bindingWindow(windows);
    const verdict: Verdict = usage === "unmetered" && !windows.length ? "UNMETERED" : unlimited && !windows.length ? "OK" : live.length ? binding?.verdict ?? "UNKNOWN" : "UNKNOWN";
    // Remote and endpoint runners have separate authentication; local login files do not describe them.
    const signIn = (opts.includePlannerSignIn || !(runner.agent === s.planner.agent && runner.account === s.planner.account)) && runner.host === null && account.kind !== "endpoint" ? accountSignIn(ctx, account, runnerScope) : null;
    const provider: ProviderStatus = {
      id: runner.name, account: account.name, usage, windows, binding, verdict,
      ...(!s.legacy ? {agent: runner.agent} : {}),
      ...(account.source === "orca" && (account.kind === "claude" || account.kind === "codex") && !orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "") ? { unavailableReason: "account folder not found" } : {}),
      ...(signIn?.signedIn === false ? { signedOutReason: signIn.reason } : {}),
      ...(endpointReason ? {unavailableReason: endpointReason} : {}),
      ...(endpointNotTested ? {endpointNotTested: true as const} : {}),
      installed: runner.host !== null || installed(BINARIES[runner.agent] ?? runner.agent),
      stale: reading.stale || windows.some(w => w.stale),      ...(blocked[runner.name] ? { blockedReason: blocked[runner.name].reason, blockedUntil: blocked[runner.name].until } : {}),
      ...(broken[runner.name] ? { brokenReason: broken[runner.name].reason } : {}),
      ...(reading.error ? { error: reading.error } : {}),
      ...(reading.error && reading.errorCode ? { errorCode: reading.errorCode } : {}),
      evidenceScope: scope, evidenceRevision: snapshot.revision,
    };
    const restrictions: { code: string; evidenceIds: string[] }[] = [];
    if (runner.enabled === false) restrictions.push({ code: "disabled", evidenceIds: [] });
    if (!provider.installed) restrictions.push({ code: "not_installed", evidenceIds: [] });
    for (const [field, code] of [["unavailableReason", "unavailable"], ["signedOutReason", "signed_out"], ["blockedReason", "blocked"], ["brokenReason", "broken"]] as const) {
      if (provider[field]) restrictions.push({ code, evidenceIds: [] });
    }
    provider.eligibility = evaluateEligibility({ now: ctx.now, scope: runnerScope,
      usage, budgetRequired: !unlimited, allowPaid: account.allowPaid, evidence: snapshot.evidence, restrictions });
    if ((reading.error || reading.stale) && provider.eligibility.state === "eligible") {
      provider.eligibility = { ...provider.eligibility, state: "uncertain", reasons: [{ code: "refresh_failed", evidenceIds: [] }] };
    }
    // The runner's one usage record: limits and facts that cover its configured model scope.
    const runnerLimit = pickLimit(snapshot.evidence.facts.budget.filter(f =>
      f.value.name === "limit" && f.value.resetsAt !== null && appliesTo(f, runnerScope)));
    provider.usageState = {
      scope: { account: account.name, runner: runner.name },
      source: reading.source ?? "unknown",
      figure: figureOf(runnerLimit, binding),
      windows,
      limit: runnerLimit,
      blockedRunners: [],
      observedAt: observedAtOf(usage, runnerLimit, provider.eligibility, ctx.now),
      freshness: freshnessOf(reading, binding, windows),
      verdict: runnerLimit ? "EXHAUSTED" : verdict,
      eligibility: provider.eligibility,
      spend: reading.spendUsd != null ? { usdWeek: reading.spendUsd, capUsdWeek: account.weeklyUsd } : null,
      error: reading.error ? { message: reading.error, at: ctx.now } : null,
    };
    // Every builder agrees on staleness: the record's freshness decides it (ADR 0030).
    provider.stale = provider.usageState!.freshness === "historical";
    return provider;
  });
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  const modeHold = readHold(ctx);
  const plannerId = s.planner.agent === "opencode" && !s.accounts[s.planner.account] ? "opencode" : formatRunnerId({...s.planner, host: null}, {...runnerDefaults(s.accounts), opencode: undefined});
  const status: Status & { accounts: AccountStatus[] } = {
    policy: policySummary(ctx), paused: readPause(ctx), modeHold,
    generatedAt: ctx.now,
    strategy: s.name,
    planner: plannerId,
    // Mode follows the active hold, else the planner's own runner record (ADR 0030).
    mode: statusMode(modeHold, byId[plannerId]?.usageState),
    disabled: (ctx.env.PACER ?? "").toLowerCase() === "off",
    calendarPace: isCalendar(profile),
    ...(warnings.length ? { warnings } : {}),
    accounts: budgets.map((budget) => {
      const { account, runners, binding, verdict, reading, snapshot, unlimited, usage, scope: accountScope, eligibility: accountEligibility } = budget;
      // Account-name marks and facts cover the account scope; runner-scoped ones never do.
      const accountLimit = pickLimit(snapshot.evidence.facts.budget.filter(f =>
        f.value.name === "limit" && f.value.resetsAt !== null && appliesTo(f, accountScope)));
      const blocked = blockedRunnersOf(accountScope, runners, snapshot, ctx.now, r => r.host ?? "local");
      // EXHAUSTED when the account itself is limited, or every runner is quota-blocked for
      // its configured model; otherwise the measured verdict. Auth never changes a verdict.
      const everyRunnerBlocked = runners.length > 0 && runners.every(r =>
        blocked.some(b => b.runner === r.name && b.model === (r.model ?? "default") && b.reason === "quota_failure"));
      const accountVerdict: Verdict = accountLimit || everyRunnerBlocked ? "EXHAUSTED" : verdict;
      const record: UsageState = {
        scope: { account: account.name },
        source: reading.source ?? "unknown",
        figure: figureOf(accountLimit, binding),
        windows: budget.windows,
        limit: accountLimit,
        blockedRunners: blocked,
        observedAt: observedAtOf(usage, accountLimit, accountEligibility, ctx.now),
        freshness: freshnessOf(reading, binding, budget.windows),
        verdict: accountVerdict,
        eligibility: accountEligibility,
        spend: reading.spendUsd != null ? { usdWeek: reading.spendUsd, capUsdWeek: account.weeklyUsd } : null,
        error: reading.error ? { message: reading.error, at: ctx.now } : null,
      };
      // The row quotes the record's figure (ADR 0030): limits.check and the native
      // rows read these legacy fields, so they cannot follow the binding window
      // when the figure is a limit. pace stays with the binding window only when
      // the figure is that window.
      const figure = record.figure;
      const figureIsBinding = figure !== null && binding !== null
        && figure.window === binding.name && figure.resetsAt === binding.resetsAt;
      return {
        name: account.name, kind: account.kind, verdict: accountVerdict, eligibility: accountEligibility, evidence: snapshot.evidence,
        usedPct: figure?.usedPct ?? null,
        pacePct: figureIsBinding ? (binding.pace ?? null) : null,
        resetsAt: figure?.resetsAt ?? null,
        window: figure?.window ?? null,
        stale: record.freshness === "historical", runners: runners.map(r => r.name),
        source: reading.source ?? null, capturedAt: reading.capturedAt,
        spendUsd: reading.spendUsd ?? null,
        usageState: record,
        ...(reading.remoteHost ? { remoteHost: reading.remoteHost } : {}),
      };
    }),
    providers,
    executors: rankExecutors(null, s, byId),
  };
  trace("providers-and-ranking");
  return status;
}
