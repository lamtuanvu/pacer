import {loadStrategy} from "../config/strategy";
import * as core from "../core";
import type {RunnerRow} from "../core/runners";
import type {Result} from "../commands/types";
import type {Ctx} from "../types";
export async function executorCommand(args:string[],ctx:Ctx):Promise<Result> {
 try {
  const s=loadStrategy(ctx),[cmd,id,...flags]=args;
  if(cmd==="list") {
   const iso=(t:number|null)=>t===null?"unblocked":new Date(t*1000).toISOString();
   const line=(r:RunnerRow)=>r.state==="blocked"?`${r.id}: blocked by user until ${iso(r.until)} · ${r.reason}`
    :r.state==="broken"?`${r.id}: not working until ${iso(r.until)} · ${r.reason}`
    :r.state==="exhausted"?`${r.id}: out of quota until ${r.until?new Date(r.until*1000).toISOString():"next reset"}`
    :`${r.id}: ok`;
   const lines=(await core.runners.list(ctx,s)).map(line);
   return {code:0,out:lines.join("\n"),err:""};
  }
  if(!["block","unblock"].includes(cmd)||!id)throw new Error("usage: pacer executor block <id> [--for <duration>] [--reason <text>] | unblock <id> | list");
  let duration:string|undefined,reason:string|undefined;
  for(let i=0;i<flags.length;i+=2) {
   if(!flags[i+1]||!["--for","--reason"].includes(flags[i])||cmd==="unblock")throw new Error(`unknown or incomplete option ${flags[i]}`);
   if(flags[i]==="--for")duration=flags[i+1];else reason=flags[i+1];
  }
  if(cmd==="block")core.runners.block(ctx,id,{for:duration,reason},s);else core.runners.unblock(ctx,id,s);
  return {code:0,out:`${id}: ${cmd==="block"?"Blocked by you":"unblocked"}`,err:""};
 }catch(e){return {code:2,out:"",err:`pacer: ${(e as Error).message}`};}
}
