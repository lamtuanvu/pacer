import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { isObj, toNum } from "../util";
import { cachedFetch } from "./cache";

export async function readMetered(ctx: Ctx, cfg: ProviderCfg): Promise<UsageReading> {
  if (!cfg.model || cfg.weeklyTokens === null || cfg.weeklyTokens <= 0) {
    return { windows: [], capturedAt: null, stale: false, error: "metered usage needs model and budget.weekly_tokens" };
  }
  const c = await cachedFetch(ctx, "opencode-stats-7d", 300, 6 * 3600, async () => {
    const r = await ctx.run(["opencode", "stats", "--models", "--json", "--days", "7"], 15000);
    if (r.code !== 0) throw new Error(`opencode stats exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return JSON.parse(r.stdout) as unknown;
  });
  if (c.value === null) return { windows: [], capturedAt: null, stale: false, error: c.error };
  const slash = cfg.model.indexOf("/");
  const providerID = cfg.model.slice(0, slash);
  const modelID = cfg.model.slice(slash + 1);
  let tokens = 0;
  const models = isObj(c.value) && Array.isArray(c.value.models) ? c.value.models : [];
  for (const m of models) {
    if (!isObj(m) || !isObj(m.model) || !isObj(m.tokens)) continue;
    if (m.model.providerID !== providerID || m.model.id !== modelID) continue;
    tokens += (toNum(m.tokens.input) ?? 0) + (toNum(m.tokens.output) ?? 0) + (toNum(m.tokens.reasoning) ?? 0);
  }
  return {
    source: "metered",
    windows: [{ name: "7d", usedPct: (100 * tokens) / cfg.weeklyTokens, resetsAt: null, lengthS: 7 * 86400, paced: false }],
    capturedAt: c.capturedAt,
    stale: c.stale,
    error: c.error,
  };
}
