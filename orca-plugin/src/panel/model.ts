import { type LinkSnapshot, type ProviderLine, type TaskData } from "../../../src/link/envelope";
import { displayName } from "./icons";
import { duration, backIn } from "./shared";
export function initialView(s: LinkSnapshot, reachable: boolean, now: number): "overview" | "setup" {
 return reachable && s.budget && [...(s.consoles ?? []), ...(s.console ? [s.console] : [])].some(c=>c.handle && now-c.heartbeatAt<=600) ? "overview" : "setup";
}
const words:Record<string,string> = {ON_PACE:"Available",OK:"Available",UNMETERED:"Available",AHEAD:"Ahead of pace",BEHIND:"Behind pace",EXPIRING:"Expiring soon",EXPIRING_SOON:"Expiring soon",NEAR_LIMIT:"Near limit",EXHAUSTED:"Out of quota"};
export const verdictWords = (v: string) => Object.hasOwn(words,v) ? words[v] : "Unknown";
export const tone = (v: string) => v === "EXHAUSTED" ? "bad" : ["AHEAD","NEAR_LIMIT","EXPIRING","EXPIRING_SOON"].includes(v) ? "warn" : ["OK","ON_PACE","BEHIND","UNMETERED"].includes(v) ? "good" : "neutral";
export function rankedProviders(s: LinkSnapshot): ProviderLine[] {
 const b=s.budget;
 return (b?.ranked ?? []).filter((r,i,a)=>r.id!==b?.planner && a.findIndex(x=>x.id===r.id)===i).map(r => b?.providers.find(p=>p.id===r.id) ?? { ...r, usedPct:null,pacePct:null,resetsAt:null,window:null,stale:false }).filter(p=>p.verdict!=="EXHAUSTED");
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
 if(p.usedPct!==null) return `${Math.round(p.usedPct)}%${p.window?` of ${p.window}`:""} used${p.resetsAt===null?"":` · resets in ${duration(p.resetsAt-now)}`}${p.stale?" · stale":""}`;
 if(p.id==="local") return "LM Studio · unmetered";
 return p.verdict==="UNKNOWN" ? "No budget reported" : "No limit reported";
}
export interface AttentionGroup { goal:string; tasks:TaskData[]; latest:TaskData; stuck:boolean; retry:ProviderLine|null }
export function attentionGroups(s: LinkSnapshot, now: number): AttentionGroup[] {
 const groups=new Map<string,TaskData[]>();
 for(const t of [...s.tasks].sort((a,b)=>b.updatedAt-a.updatedAt)) {
  if(!["failed","limit"].includes(t.state)&&!(["running","queued"].includes(t.state)&&!t.executor&&now-t.updatedAt>600)) continue;
  groups.set(t.goal,[...(groups.get(t.goal)??[]),t]);
 }
 return [...groups].map(([goal,tasks])=>({goal,tasks,latest:tasks[0],stuck:["running","queued"].includes(tasks[0].state),retry:rankedProviders(s).find(p=>!tasks.some(t=>t.executor===p.id))??null}));
}
export function attentionText(g: AttentionGroup, now: number): string {
 if(g.stuck) return `Waiting ${duration(now-g.latest.updatedAt)} with no executor picked`;
 const count=g.tasks.length, label=g.latest.state==="limit"?"Hit a limit":"Failed";
 return `${label}${count===2?" twice":count>2?` ×${count}`:""}${g.latest.executor?` on ${displayName(g.latest.executor)}`:""}`;
}
export const unavailableDetail = (p: ProviderLine, now:number) => p.verdict==="EXHAUSTED" ? `out of quota · ${backIn(p.resetsAt,now)}` : "not in the queue";
