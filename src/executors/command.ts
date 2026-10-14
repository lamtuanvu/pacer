import {loadStrategy} from "../config/strategy";
import {computeStatus} from "../engine/status";
import {readBroken} from "../exec/broken";
import {readMarks} from "../usage/reactive";
import type {Result} from "../commands/types";
import type {Ctx} from "../types";
import {blockExecutor,readBlocked,unblockExecutor} from "./blocked";
export async function executorCommand(args:string[],ctx:Ctx):Promise<Result> {
 try {
  const s=loadStrategy(ctx),[cmd,id,...flags]=args;
  if(cmd==="list") {
   const blocked=readBlocked(ctx),broken=readBroken(ctx),marks=readMarks(ctx);
   const st=await computeStatus(ctx,s);
   const lines=Object.keys(s.providers).filter(id=>id!==s.planner.agent).map(id=>{
    const block=blocked[id],bad=broken[id],p=st.providers.find(p=>p.id===id);
    const until=marks[id]>ctx.now?marks[id]:p?.binding?.resetsAt;
    const state=block?`blocked by user until ${block.until===null?"unblocked":new Date(block.until*1000).toISOString()} · ${block.reason}`:bad?`not working until ${new Date(bad.until*1000).toISOString()} · ${bad.reason}`:marks[id]>ctx.now||p?.verdict==="EXHAUSTED"?`out of quota until ${until?new Date(until*1000).toISOString():"next reset"}`:"ok";
    return `${id}: ${state}`;
   });
   return {code:0,out:lines.join("\n"),err:""};
  }
  if(!["block","unblock"].includes(cmd)||!id)throw new Error("usage: pacer executor block <id> [--for <duration>] [--reason <text>] | unblock <id> | list");
  if(!s.providers[id]||id===s.planner.agent)throw new Error(`unknown executor ${id}`);
  let duration:string|undefined,reason:string|undefined;
  for(let i=0;i<flags.length;i+=2) {
   if(!flags[i+1]||!["--for","--reason"].includes(flags[i])||cmd==="unblock")throw new Error(`unknown or incomplete option ${flags[i]}`);
   if(flags[i]==="--for")duration=flags[i+1];else reason=flags[i+1];
  }
  if(cmd==="block")blockExecutor(ctx,id,duration,reason);else unblockExecutor(ctx,id);
  return {code:0,out:`${id}: ${cmd==="block"?"Blocked by you":"unblocked"}`,err:""};
 }catch(e){return {code:2,out:"",err:`pacer: ${(e as Error).message}`};}
}
