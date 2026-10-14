import { orcaAccountHome } from "../orca/accounts";
import { parseRunnerId, formatRunnerId, runnerDefaults, resolveRunner } from "../config/runner-id";
import type { AccountCfg } from "../config/accounts";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import type { ProviderCfg, Strategy } from "../config/strategy";
import { type ActivityProfile, loadActivity } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx, UsageReading, Verdict } from "../types";
import { readAccountUsage } from "../usage/index";
import { limitWindow } from "../usage/reactive";
import { type Mode, plannerMode } from "./mode";
import { type Excluded, type ProviderStatus, type RankedExecutor, rankExecutors } from "./rank";
import { bindingWindow, evaluateWindow } from "./verdict";

export interface AccountStatus {
  name: string;
  kind: AccountCfg["kind"];
  verdict: Verdict;
  usedPct: number | null;
  pacePct: number | null;
  resetsAt: number | null;
  window: string | null;
  stale: boolean;
  runners: string[];
}

export interface Status {
  generatedAt: number;
  strategy: string;
  planner: string;
  mode: Mode;
  disabled: boolean;
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
  ctx: Ctx, s: Strategy, opts: { profile?: ActivityProfile | null; readings?: Map<string, UsageReading> } = {},
): Promise<Status & { accounts: AccountStatus[] }> {
  const blocked = Object.fromEntries(Object.entries(readBlocked(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
  const broken = Object.fromEntries(Object.entries(readBroken(ctx)).map(([id, mark]) => [resolveRunner(s, id)?.id ?? id, mark]));
  const profile = opts.profile !== undefined ? opts.profile : await loadActivity(ctx).catch(() => null);
  // Evaluate an account once; every runner draws on this same budget.
  const budgets = await Promise.all(Object.values(s.accounts).map(async (account) => {
    const runners = Object.values(s.runners).filter(r => r.account === account.name);
    const key = JSON.stringify({ account, models: [...new Set(runners.map(r => r.model))] });
    const reading = opts.readings?.get(account.name) ?? opts.readings?.get(key)
      ?? await readAccountUsage(ctx, account, runners).catch((e): UsageReading => ({
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
      const limit = limitWindow(ctx, id); return limit ? [limit] : [];
    });
    const limit = limits.sort((a, b) => (b.resetsAt ?? 0) - (a.resetsAt ?? 0))[0];
    const usageWindows = limit ? [...reading.windows.filter(w => w.name !== "limit"), limit] : reading.windows;
    const windows = usageWindows.map(w => evaluateWindow(w, ctx.now, profile, th));
    const binding = bindingWindow(windows);
    const verdict: Verdict = account.usage === "unmetered" && !windows.length ? "OK" : binding?.verdict ?? "UNKNOWN";
    return { account, runners, reading, windows, binding, verdict };
  }));
  const byAccount = Object.fromEntries(budgets.map(b => [b.account.name, b]));
  const providers: ProviderStatus[] = Object.values(s.runners).map(runner => {
    const { account, reading, windows, binding, verdict } = byAccount[runner.account];
    return {
      id: runner.name, account: account.name, usage: account.usage, windows, binding, verdict,
      ...(!s.legacy ? {agent: runner.agent} : {}),
      ...(account.source === "orca" && (account.kind === "claude" || account.kind === "codex") && !orcaAccountHome(ctx, account.kind, account.orcaAccount ?? "") ? { unavailableReason: "account folder not found" } : {}),
      installed: ctx.which(BINARIES[runner.agent] ?? runner.agent) !== null,
      stale: reading.stale,
      ...(blocked[runner.name] ? { blockedReason: blocked[runner.name].reason, blockedUntil: blocked[runner.name].until } : {}),
      ...(broken[runner.name] ? { brokenReason: broken[runner.name].reason } : {}),
      ...(reading.error ? { error: reading.error } : {}),
    };
  });
  const byId = Object.fromEntries(providers.map(p => [p.id, p]));
  const planner = byAccount[s.planner.account];
  return {
    generatedAt: ctx.now,
    strategy: s.name,
    planner: s.planner.agent === "opencode" && !s.accounts[s.planner.account] ? "opencode" : formatRunnerId({...s.planner, host: null}, {...runnerDefaults(s.accounts), opencode: undefined}),
    mode: planner ? plannerMode(planner.verdict) : "normal",
    disabled: (ctx.env.PACER ?? "").toLowerCase() === "off",
    calendarPace: isCalendar(profile),
    accounts: budgets.map(({ account, runners, binding, verdict, reading }) => ({
      name: account.name, kind: account.kind, verdict,
      usedPct: binding?.usedPct ?? null, pacePct: binding?.pace ?? null,
      resetsAt: binding?.resetsAt ?? null, window: binding?.name ?? null,
      stale: reading.stale, runners: runners.map(r => r.name),
    })),
    providers,
    executors: rankExecutors(null, s, byId),
  };
}
