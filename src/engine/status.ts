import type { AccountCfg, RunnerCfg } from "../config/accounts";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import type { ProviderCfg, Strategy } from "../config/strategy";
import { type ActivityProfile, loadActivity } from "../pace/activity";
import { isCalendar } from "../pace/clock";
import type { Ctx, UsageReading, Verdict } from "../types";
import { readUsage } from "../usage/index";
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
  accounts?: AccountStatus[];
  providers: ProviderStatus[];
  executors: { ranked: RankedExecutor[]; excluded: Excluded[] };
}

const BINARIES: Record<string, string> = { "claude-code": "claude", codex: "codex", cursor: "cursor-agent", agy: "agy" };
const NAMES: Record<string, string> = { "claude-code": "Claude", codex: "Codex", cursor: "Cursor", agy: "Antigravity", byteplus: "BytePlus", opencode: "OpenCode" };

export function binaryFor(cfg: ProviderCfg): string {
  return cfg.via === "opencode" ? "opencode" : BINARIES[cfg.id] ?? cfg.id;
}

export function displayName(id: string): string {
  return NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export async function computeStatus(
  ctx: Ctx, s: Strategy, opts: { profile?: ActivityProfile | null; readings?: Map<string, UsageReading> } = {},
): Promise<Status & { accounts: AccountStatus[] }> {
  const blocked = readBlocked(ctx);
  const broken = readBroken(ctx);
  const profile = opts.profile !== undefined ? opts.profile : await loadActivity(ctx).catch(() => null);
  // Evaluate an account once; every runner draws on this same budget.
  const budgets = await Promise.all(Object.values(s.accounts).map(async (account) => {
    const runners = Object.values(s.runners).filter(r => r.account === account.name);
    const key = JSON.stringify({ account, models: [...new Set(runners.map(r => r.model))] });
    const reading = opts.readings?.get(account.name) ?? opts.readings?.get(key)
      ?? await accountReading(ctx, account, runners).catch((e): UsageReading => ({
        windows: [], capturedAt: null, stale: false, error: String(e),
      }));
    opts.readings?.set(key, reading);
    const th = {
      ahead: s.pacing.aheadThreshold,
      behind: s.pacing.behindThreshold,
      paceScale: account.name === s.planner.account ? 1 - s.pacing.plannerReserve / 100 : 1,
    };
    // Limit marks are still written using runner ids by the execution layer.
    // Any such mark constrains the whole account, including sibling runners.
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
    planner: s.planner.agent,
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

/** Bridge the existing readers until the account-source readers land in Task 4. */
async function accountReading(ctx: Ctx, account: AccountCfg, runners: RunnerCfg[]): Promise<UsageReading> {
  // Do not accidentally report the default native login's usage for another account.
  if (account.source === "pacer" || account.source === "orca") {
    return { windows: [], capturedAt: null, stale: false, error: "account usage source not available" };
  }
  const cfg: ProviderCfg = {
    id: account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? account.name : account.kind,
    via: account.kind === "endpoint" ? "opencode" : null, model: runners[0]?.model ?? null,
    usage: account.usage, allowPaid: account.allowPaid, cooldownS: account.cooldownS,
    quotaSource: account.quotaSource === "arkcli" ? "arkcli" : null, weeklyTokens: account.weeklyTokens,
  };
  if (account.usage !== "metered") return readUsage(ctx, cfg);
  const models = [...new Set(runners.map(r => r.model))];
  const readings = await Promise.all(models.map(model => readUsage(ctx, { ...cfg, model })));
  if (!readings.length) return readUsage(ctx, cfg);
  const first = readings[0];
  return {
    ...first,
    windows: first.windows.map(w => ({ ...w, usedPct: w.usedPct === null ? null : readings.reduce((sum, r) => sum + (r.windows.find(v => v.name === w.name)?.usedPct ?? 0), 0) })),
    stale: readings.some(r => r.stale),
    ...(readings.some(r => r.error) ? { error: readings.filter(r => r.error).map(r => r.error).join("; ") } : {}),
  };
}
