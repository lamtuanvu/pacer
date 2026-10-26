import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import type { Ctx, UsageReading, UsageSource } from "../types";
import { readAccountUsage, usageRefreshCapability, type RefreshCapability } from "./index";

export interface UsageRefreshResult {
  account: string;
  capability: RefreshCapability;
  outcome: "updated" | "unchanged" | "unsupported" | "failed";
  capturedAt: number | null;
  source: UsageSource | null;
  error: string | null;
}

const pending = new Map<string, Promise<UsageRefreshResult>>();
const automaticAt = new Map<string, number>();
const AUTOMATIC_INTERVAL_S = 15 * 60;

export function refreshAccountUsage(ctx: Ctx, name: string, automatic = false): Promise<UsageRefreshResult> {
  const strategy = loadStrategy(ctx);
  const account = strategy.accounts[name];
  if (!account) throw new CoreError("invalid_input", `Unknown account ${name}`, "Run pacer account list to see configured accounts.");
  const key = `${ctx.pacerHome}:${JSON.stringify(account)}:${JSON.stringify(strategy.hosts)}`;
  const running = pending.get(key);
  if (running) return running;
  const capability = usageRefreshCapability(account);
  if (capability === "unavailable") return Promise.resolve({ account: name, capability, outcome: "unsupported", capturedAt: null, source: null, error: null });
  const runners = Object.values(strategy.runners).filter(runner => runner.account === name);
  const job = (async (): Promise<UsageRefreshResult> => {
    const prior = await readAccountUsage(ctx, account, runners, false, true, strategy.hosts);
    if (automatic && ctx.now - (automaticAt.get(key) ?? -Infinity) < AUTOMATIC_INTERVAL_S) {
      return result(name, capability, prior, "unchanged");
    }
    automaticAt.set(key, ctx.now);
    const current = await readAccountUsage(ctx, account, runners, true, false, strategy.hosts);
    return result(name, capability, current, current.error && capability !== "passive-log" ? "failed"
      : current.capturedAt !== null && current.capturedAt > (prior.capturedAt ?? -Infinity) ? "updated" : "unchanged");
  })().finally(() => { pending.delete(key); });
  pending.set(key, job);
  return job;
}

function result(account: string, capability: RefreshCapability, reading: UsageReading,
  outcome: UsageRefreshResult["outcome"]): UsageRefreshResult {
  return { account, capability, outcome, capturedAt: reading.capturedAt, source: reading.source ?? null, error: reading.error ?? null };
}

export async function refreshAllUsage(ctx: Ctx, automatic = false): Promise<UsageRefreshResult[]> {
  const names = Object.keys(loadStrategy(ctx).accounts);
  return Promise.all(names.map(name => refreshAccountUsage(ctx, name, automatic)));
}
