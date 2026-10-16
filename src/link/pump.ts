import { probeHosts } from "../remote/eligibility";
import { dispatchNotifications } from "../notify/decide";
import { repoFor, backfillRepos } from "../core/repos";
import { buildReadModel, readModelContext } from "../api/read-model";
import { snapshotTasks } from "../api/read-model/tasks";
import type { Strategy } from "../config/strategy";
import type { SetupChecklist } from "../setup/checklist";
import type { EntityData } from "./envelope";
import type { PublishOpts } from "./publish";
import { drainQueue } from "../tasks/drain";
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
import { appendActivity, rotateActivity } from "../activity/log";
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
export interface PumpDeps { status(ctx:Ctx):Promise<Status>; tasks(ctx:Ctx):TaskRecord[]; publish(ctx:Ctx,envs:Envelope[],opts?:PublishOpts):Promise<PublishReport>; strategy?(ctx:Ctx):Strategy; setup?(ctx:Ctx):Promise<SetupChecklist>; probeHosts?: typeof probeHosts; backfillRepos?(ctx:Ctx,paths:string[]):Promise<void> }
export const defaultPumpDeps:PumpDeps={status:ctx=>computeStatus(ctx,loadStrategy(ctx)),tasks:ctx=>listTasks(ctx,Infinity).map(t=>taskStatus(ctx,t.id)??t),publish:(ctx,envs,opts)=>publish(ctx,envs,opts)};
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
export function entityDiff(prev:Record<string,string>,rows:{kind:EntityData["kind"];id:string;value:unknown}[]):{envelopes:Envelope[];next:Record<string,string>} {
 const next:Record<string,string>={},envelopes:Envelope[]=[];
 for(const row of rows){const key=`${row.kind}:${row.id}`,value=JSON.stringify(row.value);next[key]=value;if(prev[key]!==value)envelopes.push({v:1,type:"entity",data:{kind:row.kind,id:row.id,value:row.value}});}
 for(const key of Object.keys(prev))if(!Object.hasOwn(next,key)){const split=key.indexOf(":");envelopes.push({v:1,type:"entity",data:{kind:key.slice(0,split) as EntityData["kind"],id:key.slice(split+1),removed:true}});}
 return {envelopes,next};
}
const alert=(a:AlertData):Envelope=>({v:1,type:"alert",data:a});
interface ActivityStatus {
  mode?: string;
  executors: Record<string, string>;
  accounts: Record<string, string>;
  refreshed: Record<string, { capturedAt: number; loggedAt: number }>;
}
const modeName = (mode: string) => mode[0]!.toUpperCase() + mode.slice(1);
function statusActivity(ctx: Ctx, st: Status): void {
  const path = join(ctx.pacerHome, "state", "activity-status.json");
  const prev = readJson<ActivityStatus>(path) ?? { executors: {}, accounts: {}, refreshed: {} };
  const next: ActivityStatus = { mode: st.mode, executors: {}, accounts: {}, refreshed: { ...prev.refreshed } };
  if (prev.mode !== undefined && prev.mode !== st.mode) {
    const reason = st.mode === "relaxed" ? "planner behind pace" : st.mode === "strict" ? "planner ahead of pace"
      : st.mode === "emergency" ? "planner out of quota" : "planner on pace";
    appendActivity(ctx, { kind: "mode", level: st.mode === "emergency" ? "warn" : "info", text: `Mode ${modeName(prev.mode)} → ${modeName(st.mode)} · ${reason}` });
  }
  for (const p of st.providers) {
    const state = p.blockedReason ? "blocked" : p.brokenReason ? "broken" : p.unavailableReason || p.installed === false ? "down"
      : p.verdict === "EXHAUSTED" ? "exhausted" : "ok";
    const reason = p.blockedReason ?? p.brokenReason ?? p.unavailableReason ?? (p.installed === false ? "not installed" : p.verdict.toLowerCase().replaceAll("_", " "));
    next.executors[p.id] = state;
    if (prev.executors[p.id] !== undefined && prev.executors[p.id] !== state) {
      appendActivity(ctx, { kind: "executor_state", level: state === "ok" ? "info" : "warn", executor: p.id, text: `${executorName(p.id)} marked ${state} · ${reason}` });
    }
  }
  const accounts = st.accounts ?? [...new Map(st.providers.map(p => [p.account ?? p.id, {
    name: p.account ?? p.id, runners: [p.id], verdict: p.verdict, usedPct: p.binding?.usedPct ?? null,
    capturedAt: p.binding ? st.generatedAt : null,
  }])).values()];
  const refreshed: typeof accounts = [];
  for (const a of accounts) {
    const state = a.verdict;
    next.accounts[a.name] = state;
    const name = executorName(a.runners[0]);
    if (prev.accounts[a.name] !== undefined && prev.accounts[a.name] !== state) {
      appendActivity(ctx, { kind: "account_state", level: state === "EXHAUSTED" || state === "UNKNOWN" ? "warn" : "info", text: `${name} marked ${state.toLowerCase().replaceAll("_", " ")} · account budget changed` });
    }
    const last = prev.refreshed[a.name];
    if (a.capturedAt !== null && (last === undefined || a.capturedAt > last.capturedAt && ctx.now - last.loggedAt >= 900)) {
      refreshed.push(a);
      next.refreshed[a.name] = { capturedAt: a.capturedAt, loggedAt: ctx.now };
    }
  }
  if (refreshed.length) {
    const planner = st.providers.find(p => p.id === st.planner);
    const plannerAccount = accounts.find(a => a.runners.includes(st.planner));
    const pct = (n: number | null | undefined) => n == null ? "unknown" : `${Math.round(n)}%`;
    const parts = [`planner ${pct(plannerAccount?.usedPct ?? planner?.binding?.usedPct)}`,
      ...refreshed.filter(a => a !== plannerAccount).map(a => `${executorName(a.runners[0])} ${pct(a.usedPct)}`)];
    appendActivity(ctx, { kind: "budget_refreshed", level: "info", text: `Budgets refreshed · ${parts.join(" · ")}` });
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) writeJsonAtomic(path, next);
}

export async function pumpOnce(ctx:Ctx,deps:PumpDeps=defaultPumpDeps):Promise<Envelope[]> {
  rotateActivity(ctx);
  await drainQueue(ctx).catch(() => {});
  const latest=readLatest(ctx),out:Envelope[]=[]; let st:Status;
  try{st=await deps.status(ctx);}catch(e){const body=clip(e instanceof Error?e.message:String(e),LIMITS.body),prev=latest.alerts.find(a=>a.key==="status-error");
    if(prev?.body!==body)out.push(alert({key:"status-error",level:"error",title:"Status could not be refreshed",body,error:body,at:ctx.now})); if(out.length)await deps.publish(ctx,out); return out;}
  const hold=readJson<{mode:string;until:number}>(join(ctx.pacerHome,"state","mode-hold.json"));
  const holdEndedPath=join(ctx.pacerHome,"state","mode-hold-ended.json");
  if(hold&&hold.until<=ctx.now&&readJson<number>(holdEndedPath)!==hold.until){
    appendActivity(ctx,{kind:"mode",level:"info",text:`Mode hold ended · back to ${modeName(st.mode)}`});
    writeJsonAtomic(holdEndedPath,hold.until);
  }
  statusActivity(ctx, st);
  const b=toBudget(st); if(budgetKey(b)!==budgetKey(latest.budget))out.push({v:1,type:"budget",data:b});
  const previous=latest.mode?.mode??null; if(previous!==b.mode){out.push({v:1,type:"mode",data:{mode:b.mode,previous,strategy:b.strategy,at:ctx.now}});if(previous!==null)out.push(alert({key:"mode",level:b.mode==="emergency"?"warn":"info",title:`Budget mode changed to ${b.mode}`,body:`${previous} -> ${b.mode} (strategy ${b.strategy})`,at:ctx.now}));}
  // Keep the main hotfix ledger even when a task falls out of the capped snapshot.
  const statesPath=join(ctx.pacerHome,"link","task-states.json"),knownRaw=readJson<unknown>(statesPath);
  const known:Record<string,string>=isObj(knownRaw)?Object.fromEntries(Object.entries(knownRaw).filter(([,v])=>typeof v==="string")) as Record<string,string>:{};
  let statesChanged=false;
  const workers=Object.values(loadOrcaState(ctx).workers), client=new OrcaClient(ctx.run,ctx.env);
  const records=deps.tasks(ctx).map(t=>resolveTask(ctx,t));
  await (deps.backfillRepos??backfillRepos)(ctx,records.map(t=>t.brief.repo).filter((p):p is string=>typeof p==="string"));
  const timesPath=join(ctx.pacerHome,"link","task-events-at.json"),times=readJson<Record<string,number>>(timesPath)??{};
  let timesChanged=false;
  const dataPath=join(ctx.pacerHome,"link","task-data-seen.json"),seenData=readJson<Record<string,TaskData>>(dataPath)??{};
  const nextData:Record<string,TaskData>={...seenData};
  const terminals=await Promise.all(records.map(async t=>{const handle=workers.find(w=>w.taskId===t.id)?.terminal;if(!handle)return false;try{return isLiveTerminal(await client.terminalShow(handle));}catch{return false;}}));
  for(const [index,t] of records.entries()){const d={...taskData(t),terminalPresent:terminals[index]},prev=latest.tasks.find(x=>x.id===d.id)??seenData[d.id],before=known[d.id]??prev?.state;
    if(known[d.id]!==d.state){known[d.id]=d.state;statesChanged=true;}
    if(prev && Object.keys({...prev,...d}).every(k=>JSON.stringify(prev[k as keyof TaskData])===JSON.stringify(d[k as keyof TaskData])))continue;
    // Coalesce progress-only changes; state transitions always publish immediately.
    if(prev && prev.state===d.state && Object.keys({...prev,...d}).filter(k=>k!=="progress").every(k=>JSON.stringify(prev[k as keyof TaskData])===JSON.stringify(d[k as keyof TaskData])) && ctx.now-(times[d.id]??-Infinity)<1)continue;
    out.push({v:1,type:"task",data:d});times[d.id]=ctx.now;nextData[d.id]=d;timesChanged=true;
    const terminal=TERMINAL_STATES.includes(d.state as TaskState);
    if(terminal&&before!==d.state&&(before!==undefined||latest.seq>0)) {
      const last=t.attempts.at(-1), name=executorName(d.executor), next=b.ranked.find(x=>x.id!==d.executor)?.id;
      const kind=d.state==="done"?"done":"failed";
      // A manual stop is recorded by core.tasks.stop, rather than reported as a failure.
      if (d.state !== "stopped") appendActivity(ctx, {
        kind: "task_settled", level: d.state === "done" ? "info" : "warn",
        text: d.state === "done" ? `${name} finished “${shortGoal(t.brief.goal, 60)}” · waiting for review` : `${name} failed “${shortGoal(t.brief.goal, 60)}”`,
        ...(t.brief.repo ? { repo: (t.repo ?? repoFor(ctx, t.brief.repo)).key } : {}), taskId: t.id,
        ...(d.executor ? { executor: d.executor } : {}), ...(t.run?.host ? { host: t.run.host } : {}),
      });
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
  if(statesChanged && report?.transports.includes("outbox"))writeJsonAtomic(statesPath,known);
  if(timesChanged && report?.transports.includes("outbox")){writeJsonAtomic(timesPath,times);writeJsonAtomic(dataPath,nextData);}
  let strategy:Strategy|undefined;
  try{strategy=(deps.strategy??loadStrategy)(ctx);}catch{/* No configured strategy yet. */}
  if(strategy){
    const probePath=join(ctx.pacerHome,"state","host-probe-at.json"),lastProbe=readJson<number>(probePath);
    if(lastProbe===null||ctx.now<lastProbe||ctx.now-lastProbe>=300){
      await (deps.probeHosts??probeHosts)(ctx,{strategy:()=>strategy!});
      writeJsonAtomic(probePath,ctx.now);
    }
    const context=deps.setup?{setup:await deps.setup(ctx),accounts:[]}:await readModelContext(ctx);
    const model=buildReadModel(ctx,{status:st,strategy,tasks:snapshotTasks(ctx,records),setup:context.setup,hosts:Object.values(strategy.hosts),signedIn:context.accounts});
    out.push(...await dispatchNotifications(ctx,model.attention,{publish:deps.publish,events:[...out]}));
    const rows:{kind:EntityData["kind"];id:string;value:unknown}[]=[
      ...model.executors.map(value=>({kind:"executor" as const,id:value.id,value})),
      ...model.accounts.map(value=>({kind:"account" as const,id:value.name,value})),
      ...model.hosts.map(value=>({kind:"host" as const,id:value.alias,value})),
      ...model.repos.map(value=>({kind:"repo" as const,id:value.key,value})),
      ...model.attention.map(value=>({kind:"attention" as const,id:value.id,value})),
      {kind:"counts",id:"counts",value:model.counts},
    ];
    const path=join(ctx.pacerHome,"link","entities-seen.json"),prev=readJson<Record<string,string>>(path)??{};
    const countsPath=join(ctx.pacerHome,"link","counts-at.json"),countsAt=readJson<number>(countsPath)??-Infinity;
    const diff=entityDiff(prev,rows);
    if(ctx.now-countsAt<1){diff.envelopes=diff.envelopes.filter(e=>e.type!=="entity"||e.data.kind!=="counts");if(prev["counts:counts"]!==undefined)diff.next["counts:counts"]=prev["counts:counts"];else delete diff.next["counts:counts"];}
    if(diff.envelopes.length){
      const entities=await deps.publish(ctx,diff.envelopes,{channel:false,bridge:false});out.push(...diff.envelopes);
      if(entities.transports.includes("outbox")){writeJsonAtomic(path,diff.next);if(diff.envelopes.some(e=>e.type==="entity"&&e.data.kind==="counts"))writeJsonAtomic(countsPath,ctx.now);}
    }
  }
  if(quotaChanged && report?.transports.includes("outbox"))writeJsonAtomic(quotaPath,quotaSeen);
  // Only acknowledge changes after the durable alert reached the link outbox.
  if((!report || report.transports.includes("outbox")) && JSON.stringify(previousSeen)!==JSON.stringify(next))writeJsonAtomic(seenPath,next);
  return out;
}
