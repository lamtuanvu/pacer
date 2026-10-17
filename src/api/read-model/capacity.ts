import type { Ctx } from "../../types";
import { slotLimit, slotBlock, type SlotUse } from "../../engine/slots";
import { readRunnerCheck } from "../../core/runner-check";
import { listJobs } from "../../jobs/registry";
import { readAuthFailures } from "../../usage/auth";
import { redactEndpointError } from "../../endpoints/state";
import type { Status } from "../../engine/status";
import type { Strategy } from "../../config/strategy";
import { parseRunnerId, resolveRunner } from "../../config/runner-id";
import { executorsFor } from "../../engine/rank";
import { verdictWords } from "../../view-model/panel";
import type { AccountSummary, ApiTask, ExecutorRow, PlannerMeter } from "./types";

export function buildExecutors(st: Status,s: Strategy,tasks: ApiTask[],now: number,ctx?: Ctx): ExecutorRow[] {
 const use:SlotUse={byExecutor:{},byHost:{},local:0};
 for(const t of tasks.filter(t=>t.state==="running")){
  if(t.executor)use.byExecutor[t.executor]=(use.byExecutor[t.executor]??0)+1;
  const host=t.host??(t.executor?resolveRunner(s,t.executor)?.host:null);
  if(host)use.byHost[host]=(use.byHost[host]??0)+1;else use.local++;
 }
 const jobs=ctx?listJobs(ctx):[];
 const planner=resolveRunner(s,st.planner)?.id??st.planner;
 const order=[...new Set([...(planner?[planner]:[]),...executorsFor(null,s),...Object.keys(s.runners)])];
 const rows:ExecutorRow[]=order.map((id,index)=>{
  const r=resolveRunner(s,id),p=st.providers.find(p=>p.id===id),account=r?.account??p?.account??parseRunnerId(id)?.account??"";
  const host=r?.host??null,used=tasks.filter(t=>t.state==="running"&&t.executor===id).length,max=slotLimit(s,id).executor;
  const enabled=r?.enabled!==false,lastCheck=ctx?readRunnerCheck(ctx,id):null,block=slotBlock(s,id,use);
  const recentFailures=tasks.filter(t=>t.executor===id&&t.state==="failed"&&t.updatedAt>=now-86400).length;
  let state:ExecutorRow["state"]="ready",reason:string|undefined;
  if(!enabled){state="disabled";reason="disabled";}
  else if(jobs.some(j=>j.kind==="runner.check"&&j.target===id&&j.state==="running")){state="checking";}
  else if(p?.blockedReason){state="blocked";reason=p.blockedReason;}
  else if(p?.brokenReason || p?.unavailableReason || p?.installed===false){state="down";reason=p.brokenReason??p.unavailableReason??"not installed";}
  else if(p?.verdict==="EXHAUSTED"){state="exhausted";}
  else if(lastCheck?.passed===false){state="failing";reason=lastCheck.detail;}
  else if(recentFailures>=2){state="failing";reason=`${recentFailures} recent failures`;}
  else if(block){state="full";reason=block;}
  else if(used>0)state="busy";
  if(reason)reason=redactEndpointError(reason).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted]");
  const places=[...new Set(Object.values(s.runners).filter(other=>other.account===account).map(other=>other.host??"this Mac"))].sort((a,b)=>a==="this Mac"?-1:b==="this Mac"?1:a.localeCompare(b)).join(" + ")||"this Mac";
  const tones:Record<ExecutorRow["state"],ExecutorRow["tone"]>={ready:"good",busy:"info",full:"info",failing:"warn",down:"bad",exhausted:"bad",blocked:"muted",disabled:"muted",checking:"info"};
  return {id,agent:r?.agent??p?.agent??parseRunnerId(id)?.agent??id,account,host,model:r?.model??null,rank:id===planner?"planner":index,enabled,state,tone:tones[state],sub:reason??`${verdictWords(p?.verdict??"UNKNOWN")} · ${places}`,...(reason?{reason}:{}),usedPct:p?.binding?.usedPct??null,pacePct:p?.binding?.pace??null,...(p?.usage==="unmetered"?{paceReason:"unmetered"}:!p?.binding?{paceReason:"no limit reported"}:{}),slots:{used,max},lastCheck:lastCheck?{...lastCheck,detail:redactEndpointError(lastCheck.detail).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted]")}:null,recentFailures,next:false};
 });
 const next=st.executors.ranked.find(e=>rows.some(r=>r.id===e.id&&["ready","busy"].includes(r.state)));
 if(next)rows.find(r=>r.id===next.id)!.next=true;
 return rows;
}
export function buildAccounts(st: Status,s: Strategy,ctx?: Ctx): AccountSummary[] {
 return Object.values(s.accounts).map(a=>{
  const runners=Object.values(s.runners).filter(r=>r.account===a.name),p=st.providers.find(p=>p.account===a.name||runners.some(r=>r.id===p.id)),status=st.accounts?.find(row=>row.name===a.name);
  return {name:a.name,agent:runners[0]?.agent??a.kind,source:a.source,usedPct:status?.usedPct??p?.binding?.usedPct??null,pacePct:status?.pacePct??p?.binding?.pace??null,window:status?.window??p?.binding?.name??null,resetsAt:status?.resetsAt??p?.binding?.resetsAt??null,verdict:status?.verdict??p?.verdict??"UNKNOWN",signedIn:ctx && Object.hasOwn(readAuthFailures(ctx),a.name) ? false : status && "signedIn" in status && status.signedIn===true ? true : null,executors:runners.map(r=>r.id)};
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
 return {runner:st.planner,agent:p?.agent??parseRunnerId(st.planner)?.agent??st.planner,usedPct,pacePct,deltaPts,verdict,activeHoursLeft:known?b!.activeHoursLeft??null:null,resetsAt:known?b!.resetsAt:null,window:known?b!.name:null,stale:p?.stale??false,advice,mode:st.mode,...(st.modeHold?{modeHeldUntil:st.modeHold.until}:{})};
}
