import { sessionTaskData } from "../session/link";
import { resolveTask } from "../tasks/resolution";
import { loadOrcaState } from "../exec/orca/state";
import { OrcaClient, isLiveTerminal } from "../exec/orca/client";
import { executorName, shortGoal } from "./notification";
import { createHash } from "node:crypto";
import { isObj } from "../util";
import { statSync } from "node:fs";
import { list, show, pathFor } from "../strategy/service";
import { readJson, writeJsonAtomic } from "../fsutil";
import { join } from "node:path";
import { loadStrategy } from "../config/strategy";
import { type Status, computeStatus } from "../engine/status";
import { taskStatus } from "../tasks/api";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord, type TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { budgetKey, toBudget } from "./budget";
import { type AlertData, type Envelope, LIMITS, type TaskData, clip } from "./envelope";
import { type PublishReport, publish } from "./publish";
import { pidAlive, readLatest } from "./store";
export interface PumpDeps { status(ctx:Ctx):Promise<Status>; tasks(ctx:Ctx):TaskRecord[]; publish(ctx:Ctx,envs:Envelope[]):Promise<PublishReport> }
export const defaultPumpDeps:PumpDeps={status:ctx=>computeStatus(ctx,loadStrategy(ctx)),tasks:ctx=>listTasks(ctx,LIMITS.tasks).map(t=>taskStatus(ctx,t.id)??t),publish:(ctx,envs)=>publish(ctx,envs)};
export function taskData(t:TaskRecord):TaskData {
  const last=t.attempts.at(-1); return {id:t.id,state:t.state,goal:clip(t.brief.goal,LIMITS.goal),executor:t.result?.executor??t.executor??last?.executor??null,backend:t.result?.backend??t.backend??null,worktree:t.result?.worktree??t.worktree??null,updatedAt:Math.max(t.createdAt,last?.startedAt??0,last?.endedAt??0,t.attemptStartedAt??0),
    ...(t.placement?.mode && t.placement.why!==undefined ? {placement:{mode:t.placement.mode,why:t.placement.why}} : {}),
    ...(t.review?{review:t.review}:{}),...(t.resolved?{resolved:t.resolved}:{}),
    ...(t.dismissed ? {dismissed:true} : {}), ...(t.retryOf ? {retryOf:t.retryOf} : {}), ...(t.retriedBy ? {retriedBy:t.retriedBy} : {}),
    ...(t.result?.brokenReason ? {brokenExecutor:t.result.brokenExecutor,brokenReason:t.result.brokenReason} : {}),
    ...(t.attemptStartedAt ? {attemptStartedAt:t.attemptStartedAt} : {}),
    ...(t.progress && ["running","queued"].includes(t.state) ? {progress:{phase:t.progress.phase,lastOutputAt:t.progress.lastOutputAt,files:t.progress.files,commits:t.progress.commits,logBytes:t.progress.logBytes}} : {}),
    ...(["running","queued"].includes(t.state) ? {runnerAlive:!!t.runnerPid && pidAlive(t.runnerPid)} : {}),
  };
}
const alert=(a:AlertData):Envelope=>({v:1,type:"alert",data:a});
export async function pumpOnce(ctx:Ctx,deps:PumpDeps=defaultPumpDeps):Promise<Envelope[]> {
  const latest=readLatest(ctx),out:Envelope[]=[]; let st:Status;
  try{st=await deps.status(ctx);}catch(e){const body=clip(e instanceof Error?e.message:String(e),LIMITS.body),prev=latest.alerts.find(a=>a.key==="status-error");
    if(prev?.body!==body)out.push(alert({key:"status-error",level:"error",title:"Status could not be refreshed",body,error:body,at:ctx.now})); if(out.length)await deps.publish(ctx,out); return out;}
  const b=toBudget(st); if(budgetKey(b)!==budgetKey(latest.budget))out.push({v:1,type:"budget",data:b});
  const previous=latest.mode?.mode??null; if(previous!==b.mode){out.push({v:1,type:"mode",data:{mode:b.mode,previous,strategy:b.strategy,at:ctx.now}});if(previous!==null)out.push(alert({key:"mode",level:b.mode==="emergency"?"warn":"info",title:`Budget mode changed to ${b.mode}`,body:`${previous} -> ${b.mode} (strategy ${b.strategy})`,at:ctx.now}));}
  // Keep the main hotfix ledger even when a task falls out of the capped snapshot.
  const statesPath=join(ctx.pacerHome,"link","task-states.json"),knownRaw=readJson<unknown>(statesPath);
  const known:Record<string,string>=isObj(knownRaw)?Object.fromEntries(Object.entries(knownRaw).filter(([,v])=>typeof v==="string")) as Record<string,string>:{};
  let statesChanged=false;
  const workers=Object.values(loadOrcaState(ctx).workers), client=new OrcaClient(ctx.run,ctx.env);
  const records=deps.tasks(ctx).map(t=>resolveTask(ctx,t));
  const terminals=await Promise.all(records.map(async t=>{const handle=workers.find(w=>w.taskId===t.id)?.terminal;if(!handle)return false;try{return isLiveTerminal(await client.terminalShow(handle));}catch{return false;}}));
  for(const [index,t] of records.entries()){const d=await sessionTaskData(ctx,taskData(t),terminals[index]),prev=latest.tasks.find(x=>x.id===d.id),before=known[d.id]??prev?.state;
    if(known[d.id]!==d.state){known[d.id]=d.state;statesChanged=true;}
    if(!prev&&before===d.state)continue;
    if(prev && Object.keys({...prev,...d}).every(k=>JSON.stringify(prev[k as keyof TaskData])===JSON.stringify(d[k as keyof TaskData])))continue;out.push({v:1,type:"task",data:d});
    const terminal=TERMINAL_STATES.includes(d.state as TaskState);
    if(terminal&&before!==d.state&&(before!==undefined||latest.seq>0)) {
      const last=t.attempts.at(-1), name=executorName(d.executor), next=b.ranked.find(x=>x.id!==d.executor)?.id;
      const kind=d.state==="done"?"done":"failed";
      if(kind!=="done"||t.fromPanel||((last?.endedAt??ctx.now)-t.createdAt)>600) out.push(alert({key:`task-${d.id}`,level:kind==="failed"?"warn":"info",title:`Task ${kind} on ${name}`,body:`${shortGoal(d.goal)}\n${kind==="done"?"Nothing to do.":next?`Open the pacer panel to retry on ${executorName(next)}.`:"Open the pacer panel to retry."}`,at:ctx.now,notification:{kind,fromPanel:t.fromPanel===true,executor:d.executor??undefined,goal:d.goal,...(next?{nextExecutor:next}:{})}}));
      const broken=t.attempts.find(a=>a.brokenReason);
      if(broken)out.push(alert({key:`broken-${broken.executor}-${d.id}`,level:"warn",title:`${executorName(broken.executor)} isn't starting`,body:`${shortGoal(d.goal)}\n${d.executor&&d.executor!==broken.executor?`Moved to ${executorName(d.executor)} automatically.`:"Open the pacer panel to retry."}`,at:ctx.now,notification:{kind:"broken",executor:broken.executor,goal:d.goal,...(d.executor&&d.executor!==broken.executor?{nextExecutor:d.executor}:{})}}));
    }
  }
  const quotaPath=join(ctx.pacerHome,"link","quota-alerts.json");
  const quotaSeen=readJson<Record<string,number>>(quotaPath) ?? {};
  let quotaChanged=false;
  for(const p of b.providers) {
    const previous=latest.budget?.providers.find(x=>x.id===p.id);
    const quotaKey=`quota-${p.id}-${p.verdict}`;
    if(["EXHAUSTED","NEAR_LIMIT"].includes(p.verdict)&&previous&&previous.verdict!=="UNKNOWN"&&previous.verdict!==p.verdict&&ctx.now-(quotaSeen[quotaKey]??-Infinity)>=1800) {
      quotaSeen[quotaKey]=ctx.now;quotaChanged=true;
      out.push(alert({key:quotaKey,level:"warn",title:`${executorName(p.id)} ${p.verdict==="EXHAUSTED"?"is out of quota":"is near its limit"}`,body:"Nothing to do.",at:ctx.now,notification:{kind:"quota",near:p.verdict==="NEAR_LIMIT",executor:p.id,...(p.resetsAt?{resetsAt:p.resetsAt}:{})}}));
    }
  }
  const seenPath=join(ctx.pacerHome,"link","strategy-seen.json"), previousSeen=readJson<unknown>(seenPath), entries=list(ctx);
  // Accept the old name-only ledger as a baseline, then persist content fingerprints.
  const seen:Record<string,unknown>|null=Array.isArray(previousSeen) ? Object.fromEntries(previousSeen.map(name=>[name,null])) : isObj(previousSeen) ? previousSeen : null;
  const next:Record<string,string>={};
  for(const entry of entries) {
    let yaml="", revision="";
    try {
      const file=pathFor(ctx,entry.name), stat=statSync(file,{bigint:true});
      // Atomic replacement changes the inode even when the bytes are identical.
      revision=`${stat.ino}:${stat.mtimeNs}`;
      yaml=show(ctx,entry.name).yaml;
    }catch{ /* Keep malformed files visible. */ }
    next[entry.name]=createHash("sha256").update(revision+"\0"+yaml).digest("hex");
    if(entry.name==="default" || !seen || Object.hasOwn(seen,entry.name) && (seen[entry.name]===null || seen[entry.name]===next[entry.name]))continue;
    const who=/# created by (.*?) on /.exec(yaml)?.[1]??"agent";
    out.push(alert({key:`strategySaved-${entry.name}`,level:"info",title:Object.hasOwn(seen,entry.name)?`Strategy "${entry.name}" updated`:`New strategy "${entry.name}" saved`,body:`${entry.summary} · by ${who}`,at:ctx.now}));
  }
  const report=out.length ? await deps.publish(ctx,out) : null;
  if(statesChanged)writeJsonAtomic(statesPath,known);
  if(quotaChanged && report?.transports.includes("outbox"))writeJsonAtomic(quotaPath,quotaSeen);
  // Only acknowledge changes after the durable alert reached the link outbox.
  if((!report || report.transports.includes("outbox")) && JSON.stringify(previousSeen)!==JSON.stringify(next))writeJsonAtomic(seenPath,next);
  return out;
}
