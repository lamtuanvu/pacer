import type { AccountCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readPluginUsage } from "../plugins/usage-broker";

export type RefreshCapability = "provider-command" | "passive-log" | "unavailable";
export interface UsageAdapter {
  capability: RefreshCapability;
  read(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh?: boolean): Promise<UsageReading>;
}

const adapters: { matches(cfg: ProviderCfg): boolean; adapter: UsageAdapter }[] = [
  { matches: cfg => cfg.usage === "quota" && cfg.id === "claude-code", adapter: {
    capability: "passive-log", read: readPluginUsage,
  } },
  { matches: cfg => cfg.usage === "quota" && cfg.id === "codex", adapter: {
    capability: "provider-command", read: readPluginUsage,
  } },
  { matches: cfg => cfg.usage === "quota" && cfg.quotaSource === "arkcli", adapter: {
    capability: "provider-command", read: readPluginUsage,
  } },
  { matches: cfg => cfg.usage === "metered", adapter: {
    capability: "provider-command", read: readPluginUsage,
  } },
  { matches: cfg => cfg.usage === "reactive", adapter: {
    capability: "unavailable", read: readPluginUsage,
  } },
  { matches: cfg => cfg.usage === "unmetered", adapter: {
    capability: "unavailable", read: readPluginUsage,
  } },
];

export function usageAdapter(cfg: ProviderCfg): UsageAdapter {
  return adapters.find(candidate => candidate.matches(cfg))?.adapter ?? {
    capability: "unavailable", read: readPluginUsage,
  };
}
