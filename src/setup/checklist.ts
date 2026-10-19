export interface SetupItem { id:string; title:string; status:"done"|"pending"|"failed"; required:boolean; installed?:boolean; detail?:string; command?:string; action?:string; agent?:string }
export interface SetupChecklist { checkedAt:number; complete:boolean; ready:boolean; items:SetupItem[] }
export interface SetupFacts {
 version:string|null; planner:string|null; service:{installed:boolean;running:boolean}; link:boolean; live:boolean;
 signedIn?:boolean; loginCommand?:string; connected?:boolean; orcaInstalled?:boolean;
 executors?:{ranked:{id:string}[];excluded:{id:string;reason:string}[]}; verdict?:string; reviewed?:boolean; skipped?:boolean;
 agents:{id:string;name:string;installed:boolean;cliInstalled?:boolean}[]; errors?:Partial<Record<"binary"|"strategy"|"service"|"link"|"connect",string>>;
}
/** Refresh the polled status facts without repeating checklist rules in clients. */
export function updateChecklist(s:SetupChecklist,f:Pick<SetupFacts,"executors"|"verdict"|"reviewed"|"skipped">):SetupChecklist {
 const ranked=f.executors?.ranked??[],excluded=f.executors?.excluded??[];
 const items=s.items.map(i=>{
  if(i.id==="executor")return {...i,status:ranked.length?"done" as const:"pending" as const,
   detail:ranked.length?ranked.map(e=>e.id).join(", "):excluded.length?excluded.map(e=>`${e.id}: ${e.reason}`).join("; "):"no executor configured",
   command:ranked.length?undefined:"pacer runner add",action:ranked.length?undefined:"nav:add-executor"};
  if(i.id==="usage")return {...i,status:f.verdict&&f.verdict!=="UNKNOWN"?"done" as const:"pending" as const};
  if(i.id==="first"&&(f.reviewed||f.skipped))return {...i,status:"done" as const,action:undefined,...(f.skipped?{detail:"Skipped"}:{})};
  return i;
 });
 const complete=items.filter(i=>i.required).every(i=>i.status==="done");
 return {...s,items,complete,ready:complete&&["executor","first"].every(id=>items.some(i=>i.id===id&&i.status==="done"))};
}
/** Pure readiness rules shared by all clients. No probes or IO belong here. Unknown facts (undefined) never block. */
export function setupChecklist(f:SetupFacts, checkedAt:number):SetupChecklist {
 const item=(id:string,title:string,required:boolean,done:boolean,detail?:string,command?:string,action?:string,error?:string):SetupItem=>({id,title,required,status:error?"failed":done?"done":"pending",...(error||detail?{detail:error??detail}:{}),...(!done||error?{...(command?{command}:{}),...(action?{action}:{})}:{})});
 const plannerAgent=f.planner?.split(/[#@]/)[0];
 const items:SetupItem[]=[
  item("binary","pacer",true,!!f.version,f.version??undefined,"pacer init",undefined,f.errors?.binary),
  item("planner","Planner",true,!!f.planner&&f.signedIn!==false,f.planner?`${f.planner}${f.signedIn===false?" · signed out":""}`:"Choose a planner",f.planner?f.loginCommand:"pacer init",undefined,f.errors?.strategy),
  item("service","Background service",true,f.service.installed&&f.service.running,undefined,"pacer service install","service.install",f.errors?.service),
  {...item("connect","Connect planner",true,!!f.planner&&f.connected!==false,f.connected!==false?"Connected":"Integration missing or changed","pacer init","agent.connect",f.errors?.connect),...(plannerAgent?{agent:plannerAgent,installed:f.agents.find(a=>a.id===plannerAgent)?.cliInstalled??false}:{})},
  item("link","Link",true,f.link,undefined,"pacer init",undefined,f.errors?.link),
  item("executor","Executor",false,false),
  item("usage","Budget data",false,!!f.verdict&&f.verdict!=="UNKNOWN",`Start a session in ${f.planner??"your planner"} once`),
  item("first","First delegation",false,!!f.reviewed||!!f.skipped,f.skipped?"Skipped":undefined,undefined,"onboarding.try"),
  ...(f.orcaInstalled?[item("live","Orca panel",false,f.live,undefined,"pacer init")]:[]),
  ...f.agents.filter(a=>a.id!==plannerAgent).map(a=>({...item(`agent:${a.id}`,a.name,false,a.installed,a.installed?"Connected":"Optional · not connected","pacer init","agent.connect"),agent:a.id,...(a.cliInstalled!==undefined?{installed:a.cliInstalled}:{})}))];
 return updateChecklist({checkedAt,complete:false,ready:false,items},f);
}
/** Timestamps must never trigger an iframe reload. */
export const setupKey=(s:SetupChecklist)=>JSON.stringify([s.ready,s.items]);
export const setupText=(s:SetupChecklist)=>s.ready?"Setup ✓":["Setup",...s.items.map(i=>`${i.status==="done"?"✓":i.status} ${i.title}${i.detail?`: ${i.detail}`:""}${i.command?` · ${i.command}`:""}`)].join("\n");
