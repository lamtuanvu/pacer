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
import type { AccountCfg } from "../config/accounts";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import type { ProviderCfg, Strategy } from "../config/strategy";
import { type ActivityProfile, loadActivity } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx, UsageReading, UsageSource, Verdict } from "../types";
import { markFreshness } from "../usage/freshness";
import { readAccountUsage } from "../usage/index";
import { limitObservation } from "../usage/reactive";
import { type Mode, plannerMode } from "./mode";
import { type Excluded, type ProviderStatus, type RankedExecutor, rankExecutors } from "./rank";
import { bindingWindow, evaluateWindow } from "./verdict";

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
}

export interface Status {
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

const BINARIES: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", agy: "agy" };

export function binaryFor(cfg: ProviderCfg): string {
  return cfg.via === "opencode" ? "opencode" : BINARIES[parseRunnerId(cfg.id)?.agent ?? cfg.id] ?? cfg.id;
}

export { displayName } from "../render/accounts";

export async function computeStatus(
  ctx: Ctx, s: Strategy, opts: { includePlannerSignIn?: boolean; cacheOnly?: boolean; profile?: ActivityProfile | null; readings?: Map<string, UsageReading>; refreshAccounts?: readonly string[] } = {},
): Promise<Status & { accounts: AccountStatus[] }> {
  const trace = statusTimer(ctx);
  const warnings = Object.values(s.accounts).filter(a => a.usageSource === "orca")
    .map(a => `account ${a.name}: usage_source orca is no longer read; using ${a.kind === "claude" || a.kind === "codex" ? "native" : "reactive"}`);
  const blocked = Object.fromEntries(Object.entries(readBlocked(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
  const broken = Object.fromEntries(Object.entries(readBroken(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
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
    // Account marks constrain all runners; retain support for older runner marks.
    const limits = [account.name, ...runners.map(r => r.name)].flatMap(id => {
      const observation = limitObservation(ctx, id); return observation ? [observation] : [];
    });
    const usage = reading.source === "reactive" ? "reactive" : account.usage;
    const fresh = markFreshness(reading, ctx.now);
    const scope = accountEvidenceScope(account, s.hosts);
    const incoming = readingEvidence(scope, reading, usage);
    // Percentages derived from a previous cap remain history, not current constraints.
    const budgetPolicy = JSON.stringify([account.weeklyUsd, account.weeklyTokens]);
    incoming.budget = incoming.budget.map(f => f.source === "metered"
      ? evidenceFact(f.scope, f.source, f.observedAt, f.validUntil, f.reason, f.value, budgetPolicy) : f);
    const auth = authObservation(ctx, scope);
    if (auth) incoming.availability.push(evidenceFact(auth.scope, "execution", auth.at, auth.at + 7200, "authentication_failed", "unavailable"));
    for (const runner of runners.filter(r => r.host === null && (opts.includePlannerSignIn || !(r.agent === s.planner.agent && r.account === s.planner.account)))) {
      const runnerScope = { ...scope, runner: runner.name, model: runner.model ?? "default", host: "local" };
      const signIn = accountSignIn(ctx, account, runnerScope);
      // A newer local login repairs only matching authentication facts, never quota or remote evidence.
      for (const recoveredScope of signIn.recoveredScopes ?? []) {
        incoming.availability.push(evidenceFact(recoveredScope, "session-log",
          signIn.recoveredAt!, signIn.recoveredAt! + 7200, "signin_observed", "ready"));
      }
    }
    for (const limit of limits.filter(v => v.manual || v.scope?.identity === scope.identity)) incoming.budget.push(evidenceFact(limit.scope ?? scope, limit.manual ? "configuration" : "execution", limit.observedAt,
      limit.until, "quota_failure", { name: "limit", usedPct: 100, resetsAt: limit.until, lengthS: 21600, paced: false }));
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
    // still reported). Such accounts are available rather than unknown, so routing does not rank them last.
    const unlimited = usage === "unmetered" || usage === "reactive" || account.usage === "metered" && account.weeklyUsd === null && account.weeklyTokens === null;
    const verdict: Verdict = unlimited && !windows.length ? "OK" : live.length ? binding?.verdict ?? "UNKNOWN" : "UNKNOWN";
    const endpoint = opts.cacheOnly ? (account.connection || account.source === "opencode" ? readEndpointState(ctx, account.name) : {}) : await endpointRow(ctx, account);
    const endpointReason = endpoint.state === "key_missing" ? "Key missing" : endpoint.state === "not_working" ? `Not working · ${endpoint.detail ?? "test task failed"}` : undefined;
    const eligibility = evaluateEligibility({ now: ctx.now, scope, usage, budgetRequired: !unlimited, allowPaid: account.allowPaid,
      evidence: snapshot.evidence, restrictions: [] });
    return { account, runners, reading: reconciledReading, windows, binding, verdict, endpointReason, endpointNotTested: endpoint.state === "not_tested", scope, snapshot, eligibility, usage, unlimited };
  }));
  trace("budgets");
  const byAccount = Object.fromEntries(budgets.map(b => [b.account.name, b]));
  const providers: ProviderStatus[] = Object.values(s.runners).map(runner => {
    const { account, reading, endpointReason, endpointNotTested, scope, snapshot, usage, unlimited } = byAccount[runner.account];
    const runnerScope = { ...scope, runner: runner.name, model: runner.model ?? "default", host: runner.host ?? "local" };
    const windows = snapshot.evidence.facts.budget.filter(f => appliesTo(f, runnerScope)).map(f => evaluateWindow({ ...f.value,
      stale: f.value.stale || !currentEvidence(f, ctx.now, evidenceDeadline(f)) }, ctx.now, profile, {
        ahead: s.pacing.aheadThreshold, behind: s.pacing.behindThreshold,
        paceScale: account.name === s.planner.account ? 1 - s.pacing.plannerReserve / 100 : 1,
      }));
    const live = windows.filter(w => !w.stale), binding = bindingWindow(live) ?? bindingWindow(windows);
    const verdict: Verdict = unlimited && !windows.length ? "OK" : live.length ? binding?.verdict ?? "UNKNOWN" : "UNKNOWN";
    // Remote and endpoint runners have separate authentication; local login files do not describe them.
    const signIn = (opts.includePlannerSignIn || !(runner.agent === s.planner.agent && runner.account === s.planner.account)) && runner.host === null && account.kind !== "endpoint" ? accountSignIn(ctx, account, runnerScope) : null;
    const provider: ProviderStatus = {
      id: runner.name, account: account.name, usage, windows, binding, verdict,
      ...(!s.legacy ? {agent: runner.agent} : {}),
      ...(account.source === "orca" && (account.kind === "claude" || account.kind === "codex") && !orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "") ? { unavailableReason: "account folder not found" } : {}),
      ...(signIn?.signedIn === false ? { signedOutReason: signIn.reason } : {}),
      ...(endpointReason ? {unavailableReason: endpointReason} : {}),
      ...(endpointNotTested ? {endpointNotTested: true as const} : {}),
      installed: runner.host !== null || ctx.which(BINARIES[runner.agent] ?? runner.agent) !== null,
      stale: reading.stale || windows.some(w => w.stale),
      ...(blocked[runner.name] ? { blockedReason: blocked[runner.name].reason, blockedUntil: blocked[runner.name].until } : {}),
      ...(broken[runner.name] ? { brokenReason: broken[runner.name].reason } : {}),
      ...(reading.error ? { error: reading.error } : {}),
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
    return provider;
  });
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  const planner = byAccount[s.planner.account];
  const modeHold = readHold(ctx);
  const status: Status & { accounts: AccountStatus[] } = {
    paused: readPause(ctx), modeHold,
    generatedAt: ctx.now,
    strategy: s.name,
    planner: s.planner.agent === "opencode" && !s.accounts[s.planner.account] ? "opencode" : formatRunnerId({...s.planner, host: null}, {...runnerDefaults(s.accounts), opencode: undefined}),
    mode: modeHold?.mode ?? (planner ? plannerMode(planner.verdict) : "normal"),
    disabled: (ctx.env.PACER ?? "").toLowerCase() === "off",
    calendarPace: isCalendar(profile),
    ...(warnings.length ? { warnings } : {}),
    accounts: budgets.map(({ account, runners, binding, verdict, reading, eligibility, snapshot }) => ({
      name: account.name, kind: account.kind, verdict, eligibility, evidence: snapshot.evidence,
      usedPct: binding?.usedPct ?? null, pacePct: binding?.pace ?? null,
      resetsAt: binding?.resetsAt ?? null, window: binding?.name ?? null,
      stale: reading.stale, runners: runners.map(r => r.name),
      source: reading.source ?? null, capturedAt: reading.capturedAt,
      spendUsd: reading.spendUsd ?? null,
      ...(reading.remoteHost ? { remoteHost: reading.remoteHost } : {}),
    })),
    providers,
    executors: rankExecutors(null, s, byId),
  };
  trace("providers-and-ranking");
  return status;
}
