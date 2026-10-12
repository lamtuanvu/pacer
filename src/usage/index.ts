import type { ProviderCfg } from "../config/strategy";
import type { Ctx, UsageReading } from "../types";
import { readByteplus } from "./byteplus";
import { readClaude } from "./claude";
import { readCodex } from "./codex";
import { readMetered } from "./metered";
import { limitWindow } from "./reactive";

async function base(ctx: Ctx, cfg: ProviderCfg): Promise<UsageReading> {
  switch (cfg.usage) {
    case "quota":
      if (cfg.id === "claude-code") return readClaude(ctx);
      if (cfg.id === "codex") return readCodex(ctx);
      if (cfg.quotaSource === "arkcli") return readByteplus(ctx);
      return { windows: [], capturedAt: null, stale: false, error: `no quota source for ${cfg.id}` };
    case "metered":
      return readMetered(ctx, cfg);
    case "reactive":
      return { windows: [{ name: "limit", usedPct: 0, resetsAt: null, lengthS: 0, paced: false }], capturedAt: ctx.now, stale: false };
    case "unmetered":
      return { windows: [], capturedAt: ctx.now, stale: false };
  }
}

const sources = new Map<string, {at:number; value?:UsageReading; pending?:Promise<UsageReading>}>();
async function cachedBase(ctx:Ctx,cfg:ProviderCfg):Promise<UsageReading> {
  const source=cfg.usage === "quota" ? cfg.quotaSource === "arkcli" ? "arkcli" : cfg.id : JSON.stringify(cfg);
  const key=`${ctx.pacerHome}:${source}`;
  const hit=sources.get(key);
  if(hit?.pending)return hit.pending;
  if(hit?.value && ctx.now-hit.at>=0 && ctx.now-hit.at<60)return hit.value;
  const entry:{at:number;value?:UsageReading;pending?:Promise<UsageReading>}={at:ctx.now};
  sources.set(key,entry);
  entry.pending=(async()=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const value=await Promise.race([base(ctx,cfg),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`usage source ${source} timed out`)),10000);})]);
      entry.value=value;return value;
    }catch(e){const value={windows:[],capturedAt:null,stale:false,error:String(e)};entry.value=value;return value;}
    finally{clearTimeout(timer);entry.pending=undefined;}
  })();
  return entry.pending;
}

/** A provider's usage reading, with any active exhausted mark applied on top. */
export async function readUsage(ctx: Ctx, cfg: ProviderCfg): Promise<UsageReading> {
  const r = await cachedBase(ctx, cfg);
  const lim = limitWindow(ctx, cfg.id);
  return lim ? { ...r, windows: [...r.windows.filter((w) => w.name !== "limit"), lim] } : r;
}
