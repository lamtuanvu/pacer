import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { agentPlans } from "../install/detection";
import { serviceBackend } from "../service";
import { currentVersion } from "../update/version";
import { readLiveHeartbeat } from "../plugin/live";
import type { Ctx } from "../types";
import { setupChecklist, setupText, type SetupChecklist, type SetupFacts } from "./checklist";
export async function checkSetup(ctx:Ctx):Promise<SetupChecklist> {
 const errors:SetupFacts["errors"]={};let planner:string|null=null,service={installed:false,running:false},link=false;
 try {planner=loadStrategy(ctx).planner.agent;}catch(e){errors.strategy=String((e as Error).message);}
 try {service=await serviceBackend(ctx).status(2000);}catch(e){errors.service=String((e as Error).message);}
 try {const r=await fetch(`http://127.0.0.1:${ctx.env.PACER_PORT||4317}/health`,{signal:AbortSignal.timeout(2000)});if(r.ok&&r.headers.get("x-pacer")==="1"){
   const token=readFileSync(join(ctx.pacerHome,"token"),"utf8").trim();
   const linked=await fetch(`http://127.0.0.1:${ctx.env.PACER_PORT||4317}/link`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});
   link=linked.ok&&linked.headers.get("x-pacer")==="1";
  }}catch{}
 return setupChecklist({version:currentVersion(),planner,service,link,live:!!readLiveHeartbeat(ctx.pacerHome),agents:agentPlans(ctx.home,ctx.pacerHome,ctx.which,ctx.env),errors},Date.now()/1000);
}
export async function checkSetupCommand(ctx:Ctx):Promise<string> {
 const result=await checkSetup(ctx);
 mkdirSync(ctx.pacerHome,{recursive:true});
 // The worker polls this request even after setup is complete; only it writes panel HTML.
 writeFileSync(join(ctx.pacerHome,"check-setup-request.json"),JSON.stringify({at:Date.now(),pid:process.pid}));
 return setupText(result);
}
