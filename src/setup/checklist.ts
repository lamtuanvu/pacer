export interface SetupItem { id:string; title:string; status:"done"|"pending"|"failed"; required:boolean; detail?:string; command?:string }
export interface SetupChecklist { checkedAt:number; complete:boolean; items:SetupItem[] }
export interface SetupFacts {
 version:string|null; planner:string|null; service:{installed:boolean;running:boolean}; link:boolean; live:boolean;
 agents:{id:string;name:string;installed:boolean}[]; errors?:Partial<Record<"binary"|"strategy"|"service"|"link",string>>;
}
/** Pure readiness rules shared by the worker, console and dashboard. */
export function setupChecklist(f:SetupFacts, checkedAt:number):SetupChecklist {
 const item=(id:"binary"|"strategy"|"service"|"link",title:string,done:boolean,detail?:string):SetupItem=>({id,title,required:true,status:f.errors?.[id]?"failed":done?"done":"pending",detail:f.errors?.[id]??detail,...(!done||f.errors?.[id]?{command:"pacer init"}:{})});
 const items:SetupItem[]=[item("binary","Binary",!!f.version,f.version??undefined),item("strategy","Strategy",!!f.planner,f.planner?`Planner: ${f.planner}`:undefined),item("service","Login service",f.service.installed&&f.service.running),item("link","Link",f.link),
 {id:"live",title:"Live plugin",required:false,status:f.live?"done":"pending",...(!f.live?{command:"pacer init"}:{})},
 ...f.agents.map(a=>({id:`agent:${a.id}`,title:a.name,required:false,status:a.installed?"done" as const:"pending" as const,detail:a.installed?"Connected":"Optional · not connected",...(!a.installed?{command:"pacer init"}:{})}))];
 return {checkedAt,complete:items.filter(i=>i.required).every(i=>i.status==="done"),items};
}
/** Timestamps must never trigger an iframe reload. */
export const setupKey=(s:SetupChecklist)=>JSON.stringify(s.items);
export const setupText=(s:SetupChecklist)=>[s.complete?"Setup ✓":"Setup",...s.items.map(i=>`${i.status==="done"?"✓":i.status} ${i.title}${i.detail?`: ${i.detail}`:""}${i.command?` · ${i.command}`:""}`)].join("\n");
