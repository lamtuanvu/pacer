import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { isObj, toNum } from "../util";
import { cachedFetch } from "./cache";

export async function readMetered(ctx: Ctx, cfg: ProviderCfg, refresh = false): Promise<UsageReading> {
  if (!cfg.model) return { windows: [], capturedAt: null, stale: false, error: "metered usage needs a model" };
  const c = await cachedFetch(ctx, "opencode-stats-7d-cost", 300, 6 * 3600, async () => {
    const r = await ctx.run(["opencode", "stats", "--models", "--cost", "--json", "--days", "7"], 15000);
    if (r.code !== 0) throw new Error(`opencode stats exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
    return JSON.parse(r.stdout) as unknown;
  }, { refresh });
  if (c.value === null) return { windows: [], capturedAt: null, stale: false, error: c.error };
  const invalid = (): UsageReading => ({ source: "metered", windows: [], capturedAt: c.capturedAt,
    stale: true, error: "Metered usage response is incomplete" });
  if (!isObj(c.value) || !Array.isArray(c.value.models)) return invalid();
  const slash = cfg.model.indexOf("/");
  const providerID = cfg.model.slice(0, slash), modelID = cfg.model.slice(slash + 1);
  let tokens = 0, cost = 0, costKnown = true;
  const models = c.value.models;
  for (const m of models) {
    if (!isObj(m) || !isObj(m.model)) return invalid();
    if (m.model.providerID !== providerID || m.model.id !== modelID) continue;
    if (!isObj(m.tokens) || [m.tokens.input, m.tokens.output, m.tokens.reasoning]
      .some(v => v !== undefined && (toNum(v) === null || Number(v) < 0))
      || [m.tokens.input, m.tokens.output, m.tokens.reasoning].every(v => v === undefined)) return invalid();
    tokens += (toNum(m.tokens.input) ?? 0) + (toNum(m.tokens.output) ?? 0) + (toNum(m.tokens.reasoning) ?? 0);
    const modelCost = toNum(m.cost);
    if (modelCost === null || modelCost < 0) costKnown = false;
    else cost += modelCost;
  }
  if (!costKnown && (cfg.weeklyUsd || !cfg.weeklyTokens)) return invalid();
  const week = { resetsAt: null, lengthS: 7 * 86400, paced: false };
  const windows = cfg.weeklyUsd ? [{ name: "7d $", usedPct: (100 * cost) / cfg.weeklyUsd, ...week }]
    : cfg.weeklyTokens ? [{ name: "7d", usedPct: (100 * tokens) / cfg.weeklyTokens, ...week }] : [];
  return { source: "metered", windows, ...(costKnown ? {spendUsd: cost} : {}), capturedAt: c.capturedAt, stale: c.stale, ...(c.error ? { error: c.error } : {}) };
}
