import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStrategy, type Strategy } from "../config/strategy";
import { AGENT_BINS, agentPlans } from "../install/detection";
import { serviceBackend } from "../service";
import { currentVersion } from "../update/version";
import { readLiveHeartbeat } from "../plugin/live";
import type { Ctx } from "../types";
import { setupChecklist, setupText, updateChecklist, type SetupChecklist, type SetupFacts } from "./checklist";
import { loginIndicator } from "../install/login";
import { formatRunnerId, runnerDefaults } from "../config/runner-id";
import { accountFolder } from "../install/role";
import { readManifest, piecesPresent, type FileChange } from "../install/manifest";
import { readText, sha256 } from "../install/fsx";
import { listTasks } from "../tasks/store";
import { computeStatus, type Status } from "../engine/status";
const statuses=new Map<string,{at:number;status:Status}>();
// Reviewed is monotonic; remember it so polling does not rescan the task store.
const reviewedHomes=new Set<string>();
function anyReviewed(ctx:Ctx):boolean {
 if(reviewedHomes.has(ctx.pacerHome))return true;
 const r=listTasks(ctx,Infinity).some(t=>!!t.review);
 if(r)reviewedHomes.add(ctx.pacerHome);
 return r;
}

/** Same hash/managed-piece checks as doctor, without running its diagnostics. */
export function integrationIntact(file:FileChange):boolean {
 if(file.action==="moved")return !existsSync(file.path)&&!!file.backup&&existsSync(file.backup);
 const text=readText(file.path);
 return text!==null&&((!!file.afterHash&&sha256(text)===file.afterHash)||(file.undo.length>0&&piecesPresent(text,file.undo)));
}
export function statusFacts(status:Status|undefined):Pick<SetupFacts,"executors"|"verdict"> {
 return {executors:status?.executors,verdict:status?.providers.find(p=>p.id===status.planner)?.verdict};
}
export function withStatus(checklist:SetupChecklist,status:Status,ctx?:Ctx,reviewed=false):SetupChecklist {
 if(ctx)statuses.set(ctx.pacerHome,{at:ctx.now,status});
 return updateChecklist(checklist,{...statusFacts(status),...(ctx?{skipped:existsSync(join(ctx.pacerHome,"onboarding","skipped")),reviewed}:{})});
}
export async function checkSetup(ctx:Ctx, options:{snapshotProbe?:boolean;status?:Status;deferStatus?:boolean}={}):Promise<SetupChecklist> {
 const errors:SetupFacts["errors"]={};let strategy:Strategy|undefined,planner:string|null=null,service={installed:false,running:false},link=false;
 try {strategy=loadStrategy(ctx);planner=strategy.planner.agent;}catch(e){errors.strategy=String((e as Error).message);}
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

 const agents=[{id:"claude-code",name:"Claude Code",bin:"claude"},{id:"codex",name:"Codex",bin:"codex"},{id:"cursor",name:"Cursor",bin:"cursor-agent"},{id:"opencode",name:"OpenCode",bin:"opencode"}].map(a=>({id:a.id,name:a.name,installed:plans.find(p=>p.id===a.id)?.installed??false,cliInstalled:AGENT_BINS[a.id as keyof typeof AGENT_BINS].some(bin=>!!ctx.which(bin))}));
 let connected=false;
 const account=strategy?.accounts[strategy.planner.account],folder=account?accountFolder(ctx,account):null;
 const login=planner?loginIndicator(ctx,planner,folder??undefined):null;
 try {
  const key=account&&account.source!=="default"?`${planner}#${strategy!.planner.account}`:planner;
  const record=key?readManifest(ctx).planners[key]:undefined;
  // Moved legacy files are cleanup bookkeeping, not part of the working integration.
  const live=record?.files.filter(f=>f.action!=="moved")??[];
  connected=live.length>0&&live.every(integrationIntact);
 }catch(e){errors.connect=e instanceof Error?e.message:String(e);}
 let status=options.status;
 if(!status&&!options.deferStatus&&strategy){
  const cached=statuses.get(ctx.pacerHome);
  status=cached&&ctx.now>=cached.at&&ctx.now-cached.at<60?cached.status:await computeStatus({...ctx,readOnly:true},strategy,{cacheOnly:true});
 }
 return setupChecklist({version:currentVersion(),planner:strategy?formatRunnerId({...strategy.planner,host:null},runnerDefaults(strategy.accounts)):planner,signedIn:login?login.loggedIn:true,loginCommand:login?.fix,connected,service,link,
  live:!!readLiveHeartbeat(ctx.pacerHome),orcaInstalled:!!(ctx.env.ORCA_CLI_COMMAND||ctx.which("orca")||existsSync("/Applications/Orca.app/Contents/Resources/bin/orca")),
  ...statusFacts(status),reviewed:anyReviewed(ctx),skipped:existsSync(join(ctx.pacerHome,"onboarding","skipped")),agents,errors},ctx.now);
}
export async function checkSetupCommand(ctx:Ctx):Promise<string> {
 const result=await checkSetup(ctx);
 mkdirSync(ctx.pacerHome,{recursive:true});
 // The worker polls this request even after setup is complete; only it writes panel HTML.
 writeFileSync(join(ctx.pacerHome,"check-setup-request.json"),JSON.stringify({at:Date.now(),pid:process.pid}));
 return setupText(result);
}
