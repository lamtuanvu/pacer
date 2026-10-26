import type { AccountCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readByteplus } from "./byteplus";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { readCodexLive } from "./codex-live";
import { readMetered } from "./metered";

export type RefreshCapability = "provider-command" | "passive-log" | "unavailable";
export interface UsageAdapter {
  capability: RefreshCapability;
  read(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh?: boolean): Promise<UsageReading>;
}

const adapters: { matches(cfg: ProviderCfg): boolean; adapter: UsageAdapter }[] = [
  { matches: cfg => cfg.usage === "quota" && cfg.id === "claude-code", adapter: {
    capability: "passive-log", read: (ctx, _cfg, account) => readClaude(ctx, account),
  } },
  { matches: cfg => cfg.usage === "quota" && cfg.id === "codex", adapter: {
    capability: "provider-command", read: (ctx, _cfg, account, refresh) => refresh && account ? readCodexLive(ctx, account) : readCodex(ctx, account),
  } },
  { matches: cfg => cfg.usage === "quota" && cfg.quotaSource === "arkcli", adapter: {
    capability: "provider-command", read: (ctx, _cfg, _account, refresh) => readByteplus(ctx, refresh),
  } },
  { matches: cfg => cfg.usage === "metered", adapter: {
    capability: "provider-command", read: (ctx, cfg, _account, refresh) => readMetered(ctx, cfg, refresh),
  } },
  { matches: cfg => cfg.usage === "reactive", adapter: {
    capability: "unavailable", read: async ctx => ({ windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: ctx.now, stale: false, source: "reactive" }),
  } },
  { matches: cfg => cfg.usage === "unmetered", adapter: {
    capability: "unavailable", read: async ctx => ({ windows: [], capturedAt: ctx.now, stale: false, source: "unmetered" }),
  } },
];

export function usageAdapter(cfg: ProviderCfg): UsageAdapter {
  return adapters.find(candidate => candidate.matches(cfg))?.adapter ?? {
    capability: "unavailable", read: async () => ({ windows: [], capturedAt: null, stale: true, error: `no quota source for ${cfg.id}` }),
  };
}
