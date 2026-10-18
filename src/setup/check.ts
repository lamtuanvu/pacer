import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { AGENT_BINS, agentPlans } from "../install/detection";
import { serviceBackend } from "../service";
import { currentVersion } from "../update/version";
import { readLiveHeartbeat } from "../plugin/live";
import type { Ctx } from "../types";
import { setupChecklist, setupText, type SetupChecklist, type SetupFacts } from "./checklist";
export async function checkSetup(ctx:Ctx, options:{snapshotProbe?:boolean}={}):Promise<SetupChecklist> {
 const errors:SetupFacts["errors"]={};let planner:string|null=null,service={installed:false,running:false},link=false;
 try {planner=loadStrategy(ctx).planner.agent;}catch(e){errors.strategy=String((e as Error).message);}
 try {service=await serviceBackend(ctx).status(2000);}catch(e){errors.service=String((e as Error).message);}
 // Serve-side checks already know the link is reachable, including on custom ports.
 if(options.snapshotProbe===false)link=true;
 else try {const r=await fetch(`http://127.0.0.1:${ctx.env.PACER_PORT||4317}/health`,{signal:AbortSignal.timeout(2000)});
  const healthy=r.ok&&r.headers.get("x-pacer")==="1";
  await r.body?.cancel();
  if(healthy){
   const token=readFileSync(join(ctx.pacerHome,"token"),"utf8").trim();
   const linked=await fetch(`http://127.0.0.1:${ctx.env.PACER_PORT||4317}/v2/snapshot`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});
   link=linked.ok&&linked.headers.get("x-pacer")==="1";
   await linked.body?.cancel();
  }
 }catch(e){errors.link=e instanceof Error?e.message:String(e);}
 const plans=agentPlans(ctx.home,ctx.pacerHome,ctx.which,ctx.env);

 const agents=[{id:"claude-code",name:"Claude Code",bin:"claude"},{id:"codex",name:"Codex",bin:"codex"},{id:"cursor",name:"Cursor",bin:"cursor-agent"},{id:"agy",name:"Antigravity",bin:"agy"},{id:"opencode",name:"OpenCode",bin:"opencode"}].map(a=>({id:a.id,name:a.name,installed:plans.find(p=>p.id===a.id)?.installed??false,cliInstalled:(a.id === "agy" ? [a.bin] : AGENT_BINS[a.id as keyof typeof AGENT_BINS]).some(bin=>!!ctx.which(bin))}));
 const checklist=setupChecklist({version:currentVersion(),planner,service,link,live:!!readLiveHeartbeat(ctx.pacerHome),agents,errors},Date.now()/1000);
 return {...checklist,items:checklist.items.map(item=>item.id.startsWith("agent:") ? {...item,installed:agents.find(a=>`agent:${a.id}`===item.id)?.cliInstalled??false} : item)};
}
export async function checkSetupCommand(ctx:Ctx):Promise<string> {
 const result=await checkSetup(ctx);
 mkdirSync(ctx.pacerHome,{recursive:true});
 // The worker polls this request even after setup is complete; only it writes panel HTML.
 writeFileSync(join(ctx.pacerHome,"check-setup-request.json"),JSON.stringify({at:Date.now(),pid:process.pid}));
 return setupText(result);
}
