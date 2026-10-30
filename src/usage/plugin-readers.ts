import type { AccountCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readPluginUsage } from "../plugins/usage-broker";

/** Compatibility entry points delegate exclusively to the contributed plugin. */
export function readQuotaPlugin(ctx: Ctx, provider: "claude-code" | "codex" | "arkcli", account?: AccountCfg, refresh = false): Promise<UsageReading> {
  return readPluginUsage(ctx, { id: provider, usage: "quota", via: null, model: null,
    quotaSource: provider === "arkcli" ? "arkcli" : null, weeklyTokens: null, weeklyUsd: null,
    allowPaid: false, cooldownS: 0 }, account, refresh);
}
export function readMeteredPlugin(ctx: Ctx, cfg: ProviderCfg, refresh = false): Promise<UsageReading> {
  return readPluginUsage(ctx, cfg, undefined, refresh);
}
