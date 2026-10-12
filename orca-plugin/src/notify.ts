import { type AlertData, type LinkSnapshot } from "../../src/link/envelope";
import { executorName, shortGoal } from "../../src/link/notification";
import type { OrcaHost } from "./orca-api";
import type { PluginSettings } from "./settings";
interface Delivery { since:number; delivered:Set<string>; pending:Map<string,AlertData>; lastSent:number }
const shownAt=new WeakMap<OrcaHost,number>();
export async function deliverNotification(host:OrcaHost,message:{title:string;body:string},nowS:number):Promise<boolean>{
  if(nowS-(shownAt.get(host)??-Infinity)<5)return false;
  // Reserve the slot before IPC so concurrent producers cannot show two notifications.
  const previous=shownAt.get(host);shownAt.set(host,nowS);
  try{const result=await host.call("notifications.show",message);if(result.delivered)return true;}catch(e){if(previous===undefined)shownAt.delete(host);else shownAt.set(host,previous);throw e;}
  if(previous===undefined)shownAt.delete(host);else shownAt.set(host,previous);return false;
}
const states=new WeakMap<PluginSettings,Delivery>();
const id=(a:AlertData)=>JSON.stringify([a.key,a.at]);
export function notificationMessage(a:AlertData):{title:string;body:string} {
  const n=a.notification, name=executorName(n?.executor);
  const next=n?.nextExecutor?`Moved to ${executorName(n.nextExecutor)} automatically.`:n?.kind==="failed"?"Open the pacer panel to retry.":"Nothing to do.";
  let title=a.title.replace(/\bpacer\b[: ]*/gi,"").trim(), body="Nothing to do.";
  if(n) {
    title=n.kind==="failed"?`Task failed on ${name}`:n.kind==="done"?`Task done on ${name}`:n.kind==="broken"?`${name} isn't starting`:n.kind==="quota"?`${name} ${n.near?"is near its limit":"is out of quota"}${!n.near&&n.resetsAt?` until ${new Date(n.resetsAt*1000).toLocaleString("en-US",{weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false}).replace(",","")}`:""}`:n.kind==="strategy"?`Switched to strategy ${n.strategy}`:"Strategy session opened";
    body=`${shortGoal(n.goal??"")}\n${n.kind==="failed"&&n.nextExecutor?`Open the pacer panel to retry on ${executorName(n.nextExecutor)}.`:next}`;
  }
  // Legacy alerts can contain CLI ids or backend diagnostics; only structured prose is shown.
  if(!n)title=title.replace(/\bagy\b/g,"Antigravity").replace(/\bcodex\b/gi,"Codex").replace(/\bcursor\b/gi,"Cursor").replace(/\bclaude-code\b/g,"Claude").replace(/\s+(via|backend)\b.*$/i,"");
  return {title:shortGoal(title,60),body};
}
export async function notifyNewAlerts(host:OrcaHost,s:LinkSnapshot,settings:PluginSettings,activatedAtS:number,nowS=Date.now()/1000):Promise<number> {
  let state=states.get(settings);
  if(!state) {state={since:settings.settingsReady===false?activatedAtS:Math.max(settings.lastAlertAt,activatedAtS-300),delivered:new Set((settings.deliveredAlerts??[]).map(a=>JSON.stringify([a.key,a.at]))),pending:new Map(),lastSent:-Infinity};states.set(settings,state);}
  const level=settings.notifications??"important";
  if(level==="off"){state.pending.clear();return settings.lastAlertAt;}
  const important=(a:AlertData)=>a.notification?.kind==="broken" || ["failed","done"].includes(a.notification?.kind??"")&&a.notification?.fromPanel===true || a.notification?.kind==="quota"&&a.notification.executor==="claude-code";
  for(const a of s.alerts)if(a.at>Math.max(state.since,settings.lastAlertAt)&&!state.delivered.has(id(a))){if(level==="all"||important(a))state.pending.set(id(a),a);}
  if(nowS-state.lastSent<5)return settings.lastAlertAt;
  const pending=[...state.pending.values()].sort((a,b)=>a.at-b.at);
  const a=pending[0];
  const batched=a?.notification?.kind==="failed"||a?.notification?.kind==="broken";
  if(batched&&nowS-a!.at<30)return settings.lastAlertAt;
  if(!a)return settings.lastAlertAt;
  const batch=batched?pending.filter(x=>x.notification?.kind===a.notification?.kind&&x.notification?.executor===a.notification?.executor&&Math.abs(x.at-a.at)<=30):[a];
  const message=notificationMessage(a);
  if(batch.length>1){message.title=a.notification?.kind==="broken"?`${executorName(a.notification.executor)} isn't starting`:`${batch.length} tasks failed on ${executorName(a.notification?.executor)}`;message.body=`${a.notification?.kind==="broken"?`${batch.length} tasks affected`:shortGoal(a.notification?.goal??"")}\n${a.notification?.nextExecutor?`Moved to ${executorName(a.notification.nextExecutor)} automatically.`:"Open the pacer panel to retry."}`;}
  const delivered=await deliverNotification(host,message,nowS);
  if(!delivered)return settings.lastAlertAt;
  state.lastSent=nowS;
  for(const item of batch){state.pending.delete(id(item));state.delivered.add(id(item));}
  settings.deliveredAlerts=[...(settings.deliveredAlerts??[]),...batch.map(x=>({key:x.key,at:x.at}))].slice(-200);
  // Persist ids before advancing the watermark so restart recovery never redelivers a completed batch.
  await host.call("settings.set",{key:"deliveredAlerts",value:settings.deliveredAlerts});
  const newest=Math.max(settings.lastAlertAt,...batch.map(x=>x.at));
  settings.lastAlertAt=state.pending.size?Math.min(newest,Math.min(...[...state.pending.values()].map(x=>x.at))-0.001):newest;
  await host.call("settings.set",{key:"lastAlertAt",value:settings.lastAlertAt});
  return settings.lastAlertAt;
}
