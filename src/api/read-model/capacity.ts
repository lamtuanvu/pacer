import { redactEndpointError } from "../../endpoints/state";
import type { Status } from "../../engine/status";
import type { Strategy } from "../../config/strategy";
import { parseRunnerId, resolveRunner } from "../../config/runner-id";
import { executorsFor } from "../../engine/rank";
import { verdictWords } from "../../view-model/panel";
import type { AccountSummary, ApiTask, ExecutorRow, PlannerMeter } from "./types";

export function buildExecutors(st: Status,s: Strategy,tasks: ApiTask[],now: number): ExecutorRow[] {
 const planner=resolveRunner(s,st.planner)?.id??st.planner;
 const order=[...new Set([...(planner?[planner]:[]),...executorsFor(null,s),...Object.keys(s.runners)])];
 const rows:ExecutorRow[]=order.map((id,index)=>{
  const r=resolveRunner(s,id),p=st.providers.find(p=>p.id===id),account=r?.account??p?.account??parseRunnerId(id)?.account??"";
  const host=r?.host??null,used=tasks.filter(t=>t.state==="running"&&t.executor===id).length,max=host?s.hosts[host]?.maxTasks??1:1;
  const recentFailures=tasks.filter(t=>t.executor===id&&t.state==="failed"&&t.updatedAt>=now-86400).length;
  let state:ExecutorRow["state"]="ready",reason:string|undefined;
  if(p?.blockedReason){state="blocked";reason=p.blockedReason;}
  else if(p?.brokenReason || p?.unavailableReason || p?.installed===false){state="down";reason=p.brokenReason??p.unavailableReason??"not installed";}
  else if(p?.verdict==="EXHAUSTED"){state="exhausted";}
  else if(recentFailures>=2){state="failing";reason=`${recentFailures} recent failures`;}
  else if(used>=max)state="full";
  else if(used>0)state="busy";
  if(reason)reason=redactEndpointError(reason).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted]");
  const places=[...new Set(Object.values(s.runners).filter(other=>other.account===account).map(other=>other.host??"this Mac"))].sort((a,b)=>a==="this Mac"?-1:b==="this Mac"?1:a.localeCompare(b)).join(" + ")||"this Mac";
  const tones:Record<ExecutorRow["state"],ExecutorRow["tone"]>={ready:"good",busy:"info",full:"info",failing:"warn",down:"bad",exhausted:"bad",blocked:"muted",disabled:"muted",checking:"info"};
  return {id,agent:r?.agent??p?.agent??parseRunnerId(id)?.agent??id,account,host,model:r?.model??null,rank:id===planner?"planner":index,enabled:true,state,tone:tones[state],sub:reason??`${verdictWords(p?.verdict??"UNKNOWN")} · ${places}`,...(reason?{reason}:{}),usedPct:p?.binding?.usedPct??null,pacePct:p?.binding?.pace??null,...(p?.usage==="unmetered"?{paceReason:"unmetered"}:!p?.binding?{paceReason:"no limit reported"}:{}),slots:{used,max},lastCheck:null,recentFailures,next:false};
 });
 const next=st.executors.ranked.find(e=>rows.some(r=>r.id===e.id&&["ready","busy"].includes(r.state)));
 if(next)rows.find(r=>r.id===next.id)!.next=true;
 return rows;
}
export function buildAccounts(st: Status,s: Strategy): AccountSummary[] {
 return Object.values(s.accounts).map(a=>{
  const runners=Object.values(s.runners).filter(r=>r.account===a.name),p=st.providers.find(p=>p.account===a.name||runners.some(r=>r.id===p.id)),status=st.accounts?.find(row=>row.name===a.name);
  return {name:a.name,agent:runners[0]?.agent??a.kind,source:a.source,usedPct:status?.usedPct??p?.binding?.usedPct??null,pacePct:status?.pacePct??p?.binding?.pace??null,window:status?.window??p?.binding?.name??null,resetsAt:status?.resetsAt??p?.binding?.resetsAt??null,verdict:status?.verdict??p?.verdict??"UNKNOWN",signedIn:status && "signedIn" in status && status.signedIn===true ? true : null,executors:runners.map(r=>r.id)};
 });
}
export function buildPlanner(st: Status): PlannerMeter | null {
 if(!st.planner)return null;
 const p=st.providers.find(p=>p.id===st.planner),b=p?.binding;
 const known=!!b&&p?.verdict!=="UNKNOWN";
 const verdict:PlannerMeter["verdict"]=!known?"unknown":({BEHIND:"behind",EXPIRING:"behind",ON_PACE:"on_pace",OK:"on_pace",AHEAD:"ahead",NEAR_LIMIT:"ahead",EXHAUSTED:"out"} as Record<string,PlannerMeter["verdict"]>)[p!.verdict]??"unknown";
 const usedPct=known?b!.usedPct:null,pacePct=known?b!.pace??null:null,deltaPts=usedPct!==null&&pacePct!==null?Math.round(usedPct-pacePct):null;
 let advice="No usage reading for the planner yet.";
 if(verdict==="behind"&&deltaPts!==null)advice=`${-deltaPts} pts under pace — spend it.`;
 if(verdict==="on_pace")advice="On pace.";
 if(verdict==="ahead"&&deltaPts!==null)advice=`${deltaPts} pts ahead of pace — delegate more.`;
 if(verdict==="out"&&b?.resetsAt!=null){const d=new Date(b.resetsAt*1000);advice=`Out of quota — back ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}.`;}
 return {runner:st.planner,agent:p?.agent??parseRunnerId(st.planner)?.agent??st.planner,usedPct,pacePct,deltaPts,verdict,activeHoursLeft:known?b!.activeHoursLeft??null:null,resetsAt:known?b!.resetsAt:null,window:known?b!.name:null,stale:p?.stale??false,advice,mode:st.mode};
}
