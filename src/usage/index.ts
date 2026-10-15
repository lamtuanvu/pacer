import type { AccountCfg, RunnerCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readByteplus } from "./byteplus";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { readMetered } from "./metered";
import { limitWindow } from "./reactive";
import { cachedRemoteUsage } from "../remote/usage";

async function base(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg): Promise<UsageReading> {
  switch (cfg.usage) {
    case "quota":
      if (cfg.id === "claude-code") return readClaude(ctx, account);
      if (cfg.id === "codex") return readCodex(ctx, account);
      if (cfg.quotaSource === "arkcli") return readByteplus(ctx);
      return { windows: [], capturedAt: null, stale: false, error: `no quota source for ${cfg.id}` };
    case "metered":
      return readMetered(ctx, cfg);
    case "reactive":
      return { windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: ctx.now, stale: false, source: "reactive" };
    case "unmetered":
      return { windows: [], capturedAt: ctx.now, stale: false, source: "unmetered" };
  }
}

const sources = new Map<string, {at:number; value?:UsageReading; pending?:Promise<UsageReading>}>();
async function cachedBase(ctx:Ctx,cfg:ProviderCfg,account?:AccountCfg):Promise<UsageReading> {
  const source=cfg.usage === "quota" ? cfg.quotaSource === "arkcli" ? "arkcli" : cfg.id : JSON.stringify(cfg);
  const key=`${ctx.pacerHome}:${source}:${JSON.stringify(account ?? null)}`;
  const hit=sources.get(key);
  if(hit?.pending)return hit.pending;
  if(hit?.value && ctx.now-hit.at>=0 && ctx.now-hit.at<60)return hit.value;
  const entry:{at:number;value?:UsageReading;pending?:Promise<UsageReading>}={at:ctx.now};
  sources.set(key,entry);
  entry.pending=(async()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const value=await Promise.race([base(ctx,cfg,account),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`usage source ${source} timed out`)),10000);})]);
      entry.value=value;return value;
    }catch(e){const value={windows:[],capturedAt:null,stale:false,error:String(e)};entry.value=value;return value;}
    finally{clearTimeout(timer);entry.pending=undefined;}
  })();
  return entry.pending;
}

/** A provider's usage reading, with any active exhausted mark applied on top. */
export async function readUsage(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg): Promise<UsageReading> {
  const r = await cachedBase(ctx, cfg, account);
  const lim = limitWindow(ctx, cfg.id);
  return lim ? { ...r, windows: [...r.windows.filter((w) => w.name !== "limit"), lim] } : r;
}

/** Read one budget per account, aggregating metered model usage exactly once. */
export async function readAccountUsage(ctx: Ctx, account: AccountCfg, runners: RunnerCfg[]): Promise<UsageReading> {
  const model = runners[0]?.model ?? account.model;
  const cfg: ProviderCfg = {
    id: account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? account.name : account.kind,
    via: account.kind === "endpoint" ? "opencode" : null, model,
    usage: account.usage, allowPaid: account.allowPaid, cooldownS: account.cooldownS,
    quotaSource: account.quotaSource === "arkcli" || account.usageSource === "arkcli" ? "arkcli" : null,
    weeklyTokens: account.weeklyTokens,
  };
  // Orca is never a usage source; a legacy usage_source: orca reads natively (claude/codex) or reactively.
  if (account.usageSource === "orca" && account.kind !== "claude" && account.kind !== "codex") cfg.usage = "reactive";
  if (account.usage !== "metered") {
    const local = await cachedBase(ctx, cfg, account);
    const remote = account.kind === "codex" && account.usage === "quota" ? cachedRemoteUsage(ctx, account.name) : null;
    return remote?.capturedAt != null && (local.capturedAt === null || remote.capturedAt > local.capturedAt) ? remote : local;
  }
  const models = [...new Set(runners.map(r => r.model))];
  const readings = await Promise.all(models.map(model => cachedBase(ctx, { ...cfg, model }, account)));
  if (!readings.length) return cachedBase(ctx, cfg, account);
  const first = readings[0];
  return {
    ...first,
    windows: first.windows.map(w => ({ ...w, usedPct: w.usedPct === null ? null : readings.reduce((sum, r) => sum + (r.windows.find(v => v.name === w.name)?.usedPct ?? 0), 0) })),
    stale: readings.some(r => r.stale),
    ...(readings.some(r => r.error) ? { error: readings.filter(r => r.error).map(r => r.error).join("; ") } : {}),
  };
}
