import { withLock } from "../core/lock";
import { writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
import { writeBridge } from "./bridge";
import { detectChannel, sendChannel } from "./channel";
import { type Envelope, type LinkSnapshot, reduce } from "./envelope";
import { latestPath } from "./paths";
import { type OutboxEntry, appendOutbox, currentSnapshot, readLatest } from "./store";
export interface PublishOpts { platform?:NodeJS.Platform; bridge?:boolean; channel?:boolean }
export interface PublishReport { seq:number; transports:("outbox"|"bridge"|"channel")[]; errors:string[] }
const msg=(e:unknown)=>(e instanceof Error?e.message:String(e));
/** Publish to every reachable transport. Never throws. */
export async function publish(ctx:Ctx,envs:Envelope[],o:PublishOpts={}):Promise<PublishReport> {
  const report:PublishReport={seq:0,transports:[],errors:[]}; let snap:LinkSnapshot|null=null;
  try {
    await withLock(ctx,"link",async()=>{let s=readLatest(ctx); const entries:OutboxEntry[]=[];
      for(const envelope of envs){s=reduce(s,envelope,ctx.now);entries.push({seq:s.seq,at:ctx.now,envelope});}
      if(entries.length){appendOutbox(ctx,entries);writeJsonAtomic(latestPath(ctx),s);} report.seq=s.seq; snap=currentSnapshot(ctx);
    },{timeoutMs:5000}); report.transports.push("outbox");
  } catch(e){report.errors.push(`outbox: ${msg(e)}`);return report;}
  const legacy=envs.filter(e=>e.type!=="entity");
  if(o.bridge!==false&&snap&&(!envs.length||legacy.length)){const r=writeBridge(ctx,snap,o.platform);if(r==="written")report.transports.push("bridge");else if(r!=="skipped")report.errors.push(`bridge: ${r}`);}
  if(o.channel!==false&&legacy.length){try{if(await detectChannel(ctx)){for(const e of legacy)await sendChannel(ctx,e);report.transports.push("channel");}}catch(e){report.errors.push(`channel: ${msg(e)}`);}}
  return report;
}
/** Rewrite the bridge with the current snapshot (console heartbeat). */
export function refreshBridge(ctx:Ctx,platform?:NodeJS.Platform):string{return writeBridge(ctx,currentSnapshot(ctx),platform);}
