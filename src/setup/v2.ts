import type { SetupChecklist, SetupItem } from "./checklist";
/** The frozen 2.x checklist predates login, integrity and onboarding checks. */
export function legacySetup(s:Pick<SetupChecklist,"items">) {
 const find=(id:string)=>s.items.find(i=>i.id===id);
 const row=(id:string,title:string,required:boolean,status:SetupItem["status"]="pending"):SetupItem=>({id,title,status,required});
 const planner=find("planner"),connect=find("connect");
 const items=[row("binary","Binary",true,find("binary")?.status),row("strategy","Strategy",true,planner?.status==="failed"?"failed":planner?.detail&&planner.detail!=="Choose a planner"?"done":"pending"),row("service","Login service",true,find("service")?.status),row("link","Link",true,find("link")?.status),row("live","Live plugin",false,find("live")?.status),
 ...Object.entries({"claude-code":"Claude Code",codex:"Codex",cursor:"Cursor",opencode:"OpenCode"}).map(([id,name])=>row(`agent:${id}`,name,false,find(`agent:${id}`)?.status??(connect?.agent===id?connect.status:"pending")))];
 const open=items.filter(i=>i.required&&i.status!=="done").length;
 return {complete:open===0,open,items};
}
export function legacyCheck(s:SetupChecklist) {
 const mapped=legacySetup(s),planner=s.items.find(i=>i.id==="planner");
 return {checkedAt:s.checkedAt,complete:mapped.complete,items:mapped.items.map(i=>{
  const source=s.items.find(x=>x.id===i.id),agent=i.id.startsWith("agent:");
  const detail=i.id==="strategy"?(planner?.status==="failed"?planner.detail:planner?.detail&&planner.detail!=="Choose a planner"?`Planner: ${planner.detail.replace(/ · signed out$/,"")}`:undefined):agent?(i.status==="done"?"Connected":"Optional · not connected"):source?.detail;
  return {...i,...(agent?{installed:source?.installed??(s.items.find(x=>x.id==="connect"&&`agent:${x.agent}`===i.id)?.installed??false)}:{}),...(detail?{detail}:{}),...(i.status!=="done"?{command:"pacer init"}:{})};
 })};
}
