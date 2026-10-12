import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../fsutil";
import type { Ctx } from "../types";
export interface Block { until: number | null; reason: string }
const path=(ctx:Ctx)=>join(ctx.pacerHome,"blocked.json");
export function readBlocked(ctx:Ctx):Record<string,Block> {
 const raw=readJson<Record<string,Block>>(path(ctx))??{};
 return Object.fromEntries(Object.entries(raw).filter(([,m])=>m&&typeof m.reason==="string"&&(m.until===null||typeof m.until==="number"&&m.until>ctx.now)));
}
export function blockExecutor(ctx:Ctx,id:string,duration?:string,reason="Paused by user"):void {
 let until:number|null=null;
 if(duration) {
  const match=/^(\d+)(s|m|h|d)$/.exec(duration);
  if(!match || Number(match[1])<=0)throw new Error("duration must be a positive number followed by s, m, h or d");
  until=ctx.now+Number(match[1])*({s:1,m:60,h:3600,d:86400}[match[2]]!);
  if(!Number.isFinite(until))throw new Error("invalid duration");
 }
 writeJsonAtomic(path(ctx),{...readBlocked(ctx),[id]:{until,reason:reason.trim()||"Paused by user"}});
}
export function unblockExecutor(ctx:Ctx,id:string):void {
 const blocks=readBlocked(ctx);delete blocks[id];writeJsonAtomic(path(ctx),blocks);
}
