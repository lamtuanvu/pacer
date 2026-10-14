import type { AccountCfg } from "../config/accounts";
import { readOrcaAccounts, type OrcaRateLimit, type OrcaWindow } from "../orca/accounts";
import type { Ctx, UsageReading, UsageWindow } from "../types";
import { parseTs } from "../util";

const PROVIDERS: Record<string, string> = {
  agy: "antigravity", "opencode-go": "opencodeGo", "google": "gemini", "google-gemini": "gemini",
  "kimi-for-coding": "kimi", "kimi-coding": "kimi", "moonshot": "kimi",
};
function providerFor(account: AccountCfg, model: string | null): string {
  if (account.kind !== "endpoint") return PROVIDERS[account.kind] ?? account.kind;
  const id = (model ?? account.model)?.split("/")[0] ?? account.name;
  return PROVIDERS[id] ?? id;
}
export function orcaUsageReading(ctx: Ctx, limit: OrcaRateLimit): UsageReading {
  const windows: UsageWindow[] = [];
  const add = (name: string, w: OrcaWindow | undefined, defaultMinutes: number) => {
    if (!w) return;
    const minutes = w.windowMinutes ?? defaultMinutes;
    windows.push({
      name: name === "session" ? `${Math.round(minutes / 60)}h` : name,
      usedPct: w.usedPercent, resetsAt: parseTs(w.resetsAt), lengthS: minutes * 60, paced: minutes >= 1440,
    });
  };
  add("session", limit.session, 300);
  add("weekly", limit.weekly, 10080);
  add("monthly", limit.monthly, 43200);
  for (const [i, w] of (limit.buckets ?? []).entries()) add(w.name ?? `bucket-${i + 1}`, w, 0);
  const capturedAt = parseTs(limit.updatedAt);
  return {
    windows, capturedAt, stale: capturedAt !== null && ctx.now - capturedAt > 86400,
    ...(limit.error ? {error: limit.error} : !windows.length ? {error: "no Orca rate-limit windows"} : {}),
  };
}

/** Null means Orca cannot supply this source; a missing linked account must never borrow the active budget. */
export async function readOrca(ctx: Ctx, account: AccountCfg, model: string | null = account.model): Promise<UsageReading | null> {
  const data = await readOrcaAccounts(ctx);
  if (!data) return null;
  const provider = providerFor(account, model);
  let limit: OrcaRateLimit | undefined = data.rateLimits[provider];
  if (account.orcaAccount) {
    limit = limit?.accountId === account.orcaAccount ? limit :
      data.inactive[provider]?.find(v => v.accountId === account.orcaAccount);
    if (!limit) return {windows: [], capturedAt: null, stale: false, error: "Orca account rate limits not found"};
  }
  return limit ? orcaUsageReading(ctx, limit) : null;
}
