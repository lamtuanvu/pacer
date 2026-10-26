import { accountEvidenceScope } from "../evidence/scope";
import { statusTimer } from "./trace";
import type { AccountCfg, RunnerCfg } from "../config/accounts";
import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { usageAdapter } from "./adapter";
export type { RefreshCapability } from "./adapter";
import { limitWindow } from "./reactive";
import { recordAuthReading } from "./auth";
import { cachedRemoteUsage } from "../remote/usage";

async function base(ctx: Ctx, cfg: ProviderCfg, account?: AccountCfg, refresh = false): Promise<UsageReading> {
  return usageAdapter(cfg).read(ctx, cfg, account, refresh);
}

const sources = new Map<string, {at:number; value?:UsageReading; pending?:Promise<UsageReading>; refreshing?:boolean}>();
async function cachedBase(ctx:Ctx,cfg:ProviderCfg,account?:AccountCfg, refresh = false, cacheOnly = false, hosts?: Record<string, import("../config/hosts").HostCfg>):Promise<UsageReading> {
  const source=cfg.usage === "quota" ? cfg.quotaSource === "arkcli" ? "arkcli" : cfg.id : JSON.stringify(cfg);
  const key=`${ctx.pacerHome}:${source}:${JSON.stringify(account ?? null)}:${JSON.stringify(hosts ?? {})}`;
  const hit=sources.get(key);
  if(cacheOnly)return hit?.value ?? {windows: [], capturedAt: null, stale: true};
  if(hit?.pending) {
    if (!refresh || hit.refreshing) return hit.pending;
    await hit.pending;
    return cachedBase(ctx, cfg, account, true, false, hosts);
  }
  if(!refresh && hit?.value && ctx.now-hit.at>=0 && ctx.now-hit.at<60)return hit.value;
  const entry:{at:number;value?:UsageReading;pending?:Promise<UsageReading>;refreshing?:boolean}={at:ctx.now,refreshing:refresh};
  sources.set(key,entry);
  entry.pending=(async()=>{
    const trace = statusTimer(ctx);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const value=await Promise.race([base(ctx,cfg,account,refresh),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`usage source ${source} timed out`)),10000);})]);
      if (account) recordAuthReading(ctx, account.name, value, accountEvidenceScope(account, hosts));
      entry.value = value.error && hit?.value?.windows.length
        ? { ...hit.value, stale: true, error: value.error }
        : hit?.value?.capturedAt != null && (value.capturedAt == null || value.capturedAt < hit.value.capturedAt)
          ? hit.value : value;
      return entry.value;
    } catch (e) {
      const value = {windows: [], capturedAt: null, stale: false, error: String(e)};
      if (account) recordAuthReading(ctx, account.name, value, accountEvidenceScope(account, hosts));
      entry.value = hit?.value?.windows.length
        ? { ...hit.value, stale: true, error: value.error }
        : value;
      return entry.value;
    }
    finally{trace(`usage.${cfg.quotaSource === "arkcli" ? "arkcli" : cfg.id}`);clearTimeout(timer);entry.pending=undefined;}
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
export async function readAccountUsage(ctx: Ctx, account: AccountCfg, runners: RunnerCfg[], refresh = false, cacheOnly = false, hosts?: Record<string, import("../config/hosts").HostCfg>): Promise<UsageReading> {
  const model = runners[0]?.model ?? account.model;
  const cfg: ProviderCfg = {
    id: account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? account.name : account.kind,
    via: account.kind === "endpoint" ? "opencode" : null, model,
    usage: account.usage, allowPaid: account.allowPaid, cooldownS: account.cooldownS,
    quotaSource: account.quotaSource === "arkcli" || account.usageSource === "arkcli" ? "arkcli" : null,
    weeklyTokens: account.weeklyTokens, weeklyUsd: account.weeklyUsd,
  };
  // Orca is never a usage source; a legacy usage_source: orca reads natively (claude/codex) or reactively.
  if (account.usageSource === "orca" && account.kind !== "claude" && account.kind !== "codex") cfg.usage = "reactive";
  if (account.usage !== "metered") {
    const local = await cachedBase(ctx, cfg, account, refresh, cacheOnly, hosts);
    const remote = account.kind === "codex" && account.usage === "quota" ? cachedRemoteUsage(ctx, account, hosts) : null;
    if (!remote) return local;
    const remoteNewer = remote.capturedAt != null && (local.capturedAt === null || remote.capturedAt > local.capturedAt);
    return remoteNewer ? { ...remote, alternatives: [...(remote.alternatives ?? []), local] } : { ...local, alternatives: [...(local.alternatives ?? []), remote] };
  }
  const models = [...new Set(runners.map(r => r.model))];
  const readings = await Promise.all(models.map(model => cachedBase(ctx, { ...cfg, model }, account, refresh, cacheOnly, hosts)));
  if (!readings.length) return cachedBase(ctx, cfg, account, refresh, cacheOnly, hosts);
  const first = readings[0];
  return {
    ...first,
    spendUsd: readings.every(r => r.spendUsd != null) ? readings.reduce((sum, r) => sum + r.spendUsd!, 0) : undefined,
    windows: first.windows.map(w => ({ ...w, usedPct: readings.some(r => !!r.error || r.windows.find(v => v.name === w.name)?.usedPct == null) ? null : readings.reduce((sum, r) => sum + (r.windows.find(v => v.name === w.name)?.usedPct ?? 0), 0) })),
    capturedAt: readings.every(r => r.capturedAt !== null) ? Math.min(...readings.map(r => r.capturedAt!)) : null,
    stale: readings.some(r => r.stale || !!r.error),
    ...(readings.some(r => r.error) ? { error: readings.filter(r => r.error).map(r => r.error).join("; ") } : {}),
  };
}

/** Refresh is a source capability, not a request to read native credentials. */
export function usageRefreshCapability(account: AccountCfg): "provider-command" | "passive-log" | "unavailable" {
  const cfg = { id: account.kind === "claude" ? "claude-code" : account.kind === "endpoint" ? account.name : account.kind,
    usage: account.usage, quotaSource: account.quotaSource === "arkcli" || account.usageSource === "arkcli" ? "arkcli" : null } as ProviderCfg;
  return usageAdapter(cfg).capability;
}
