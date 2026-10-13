import { type LinkSnapshot, type ProviderLine, type TaskData } from "../../../src/link/envelope";
import { displayName } from "./icons";
import { duration, backIn } from "./shared";
export function initialView(s: LinkSnapshot, reachable: boolean, now: number): "overview" | "setup" {
 return reachable && s.budget && [...(s.consoles ?? []), ...(s.console ? [s.console] : [])].some(c=>c.handle && now-c.heartbeatAt<=30) ? "overview" : "setup";
}
const words:Record<string,string> = {ON_PACE:"Available",OK:"Available",UNMETERED:"Available",AHEAD:"Ahead of pace",BEHIND:"Behind pace",EXPIRING:"Expiring soon",EXPIRING_SOON:"Expiring soon",NEAR_LIMIT:"Near limit",EXHAUSTED:"Out of quota"};
export const verdictWords = (v: string) => Object.hasOwn(words,v) ? words[v] : "Unknown";
export const tone = (v: string) => v === "EXHAUSTED" ? "bad" : ["AHEAD","NEAR_LIMIT","EXPIRING","EXPIRING_SOON"].includes(v) ? "warn" : ["OK","ON_PACE","BEHIND","UNMETERED"].includes(v) ? "good" : "neutral";
export function rankedProviders(s: LinkSnapshot): ProviderLine[] {
 const b=s.budget;
 return (b?.ranked ?? []).filter((r,i,a)=>r.id!==b?.planner && a.findIndex(x=>x.id===r.id)===i).map(r => b?.providers.find(p=>p.id===r.id) ?? { ...r, usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false }).filter(p=>p.verdict!=="EXHAUSTED"&&!p.brokenReason&&!p.blockedReason);
}
export function mutedProviders(s: LinkSnapshot): ProviderLine[] {
 const ids=new Set(rankedProviders(s).map(p=>p.id));
 return (s.budget?.providers??[]).filter(p=>p.id!==s.budget?.planner&&!ids.has(p.id));
}
export function headline(p?: ProviderLine, _now=0): string {
 switch(p?.verdict) {
  case "OK": case "ON_PACE": return "You're on pace for the week.";
  case "AHEAD": case "NEAR_LIMIT": return "Claude is ahead of pace. Slow down planning.";
  case "BEHIND": return "Claude is behind pace. Room for more planning.";
  case "EXHAUSTED": return p.resetsAt === null ? "Claude is out of quota until its next reset." : `Claude is out until ${new Date(p.resetsAt*1000).toLocaleString([], {weekday:"short",hour:"2-digit",minute:"2-digit"})}.`;
  default: return "Budget unknown.";
 }
}
export function answerDetail(s: LinkSnapshot, now: number): string {
 const p=s.budget?.providers.find(p=>p.id===s.budget?.planner), top=rankedProviders(s)[0];
 const parts:string[]=[];
 if(p?.usedPct!=null) parts.push(`${displayName(p.id)} has ${Math.round(100-p.usedPct)}% left${p.resetsAt==null?"":` with ${duration(p.resetsAt-now,true)} to go`}.`);
 else if(p?.resetsAt!=null) parts.push(`${displayName(p.id)} has ${duration(p.resetsAt-now,true)} to go.`);
 if(top) parts.push(`New work goes to ${displayName(top.id)}.`);
 return parts.join(" ");
}
export function providerDetail(p: ProviderLine, now: number): string {
 if(p.brokenReason) return `Not working · ${p.brokenReason}`;
 if(p.blockedReason) return "Blocked by you";
 if(p.usedPct!==null) return `${Math.round(p.usedPct)}%${p.window?` of ${p.window}`:""} used${p.resetsAt===null?"":` · resets in ${duration(p.resetsAt-now)}`}${p.stale?" · stale":""}`;
 if(p.id==="local") return "LM Studio · unmetered";
 return p.verdict==="UNKNOWN" ? "No budget reported" : "No limit reported";
}
export interface AttentionGroup { count:number; goal:string; tasks:TaskData[]; latest:TaskData; stuck:boolean; retry:ProviderLine|null; brokenExecutor?:string; brokenReason?:string }
export function attentionGroups(s: LinkSnapshot, now: number): AttentionGroup[] {
 const groups=new Map<string,TaskData[]>();
 const resolved = new Set(s.tasks.filter(t=>t.state==="done"&&t.retryOf).map(t=>t.retryOf));
 for(const t of [...s.tasks].sort((a,b)=>b.updatedAt-a.updatedAt)) {
  if(t.resolved || t.review || t.dismissed || (t.retriedBy && s.tasks.some(retry=>retry.id===t.retriedBy)) || resolved.has(t.id) || now-t.updatedAt>3*86400)continue;
  if(!["failed","limit","partial"].includes(t.state)&&!(["running","queued"].includes(t.state)&&!t.executor&&!t.attemptStartedAt&&!t.runnerAlive&&now-t.updatedAt>600)) continue;
  const key=t.brokenExecutor ? `broken:${t.brokenExecutor}` : t.goal;
  groups.set(key,[...(groups.get(key)??[]),t]);
 }
 const count=(tasks:TaskData[])=>{
  const seen=new Set<string>();
  for(const task of tasks){let t:TaskData|undefined=task;while(t&&!seen.has(t.id)){seen.add(t.id);t=s.tasks.find(p=>p.id===t!.retryOf);}}
  return seen.size;
 };
 return [...groups].map(([_key,tasks])=>({count:count(tasks),goal:tasks[0].brokenExecutor?`${displayName(tasks[0].brokenExecutor)} is not working`:tasks[0].goal,tasks,latest:tasks[0],stuck:["running","queued"].includes(tasks[0].state),retry:rankedProviders(s).find(p=>!tasks.some(t=>t.executor===p.id))??null,...(tasks[0].brokenExecutor?{brokenExecutor:tasks[0].brokenExecutor,brokenReason:tasks[0].brokenReason}: {})}));
}
export function attentionText(g: AttentionGroup, now: number): string {
 if(g.brokenExecutor) return `${displayName(g.brokenExecutor)} is not working: ${g.brokenReason ?? "CLI startup failed"} · ${g.tasks.length} tasks affected`;
 if(g.stuck) return `Waiting ${duration(now-g.latest.updatedAt)} with no executor picked`;
 if(g.latest.state==="partial") return `Needs review${g.latest.executor?` on ${displayName(g.latest.executor)}`:""}`;
 const count=g.count, label=g.latest.state==="limit"?"Hit a limit":"Failed";
 return `${label}${count===2?" twice":count>2?` ×${count}`:""}${g.latest.executor?` on ${displayName(g.latest.executor)}`:""}`;
}
export const unavailableDetail = (p: ProviderLine, now:number) => p.blockedReason ? "Blocked by you" : p.brokenReason ? `Not working · ${p.brokenReason}` : p.verdict==="EXHAUSTED" ? `out of quota · ${backIn(p.resetsAt,now)}` : "not in the queue";
