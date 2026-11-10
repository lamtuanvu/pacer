import { visibleTaskState } from "../tasks/types";
import { agentSessionsRevision } from '../session/agents-state';
import { readProjectStrategies, type ProjectStrategyFile } from "../config/project-strategies";
import { buildExecutors } from "../api/read-model/capacity";
import { resume, type PauseState } from "../core/pause";
import { taskTitle } from "../core/short-title";
import { probeHosts } from "../remote/eligibility";
import { dispatchNotifications } from "../notify/decide";
import { repoFor, backfillRepos } from "../core/repos";
import { buildReadModel, readModelContext, retryTargetFor } from "../api/read-model";
import { apiTasks, snapshotTasks } from "../api/read-model/tasks";
import type { Strategy } from "../config/strategy";
import type { SetupChecklist } from "../setup/checklist";
import type { EntityData } from "./envelope";
import { drainQueue } from "../tasks/drain";
import { sessionTaskData } from "../session/link";
import { withTimeout } from "../core/path-probe";
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
import { readTasksByIds, listTasks, taskIdPage, snapshotTaskIds } from "../tasks/store";
import { taskChangesSince } from "../tasks/changes";
import { TERMINAL_STATES, type TaskRecord, type TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { defaultLedgerApi, type PumpLedgerApi, type LedgerRow } from "./ledger";
import { type ApiTask } from "../api/read-model/types";
import { type ExecutorRow } from "../api/read-model/types";
import { budgetKey, toBudget } from "./budget";
import { type AlertData, type OutboxEvent, LIMITS, type TaskData, clip } from "./envelope";
import { type PublishReport, publish } from "./publish";
import { pidAlive, readLatest } from "./store";
export interface PumpDeps { status(ctx:Ctx):Promise<Status>; tasks(ctx:Ctx, ids?: Set<string>):TaskRecord[]; publish(ctx:Ctx,envs:OutboxEvent[]):Promise<PublishReport>; strategy?(ctx:Ctx):Strategy; setup?(ctx:Ctx):Promise<SetupChecklist>; probeHosts?: typeof probeHosts; backfillRepos?(ctx:Ctx,paths:string[]):Promise<void> }
export const defaultPumpDeps:PumpDeps={status:ctx=>computeStatus(ctx,loadStrategy(ctx)),tasks:(ctx,ids)=>(ids?readTasksByIds(ctx,ids):listTasks(ctx,Infinity)),publish};
export function acceptanceState(t: TaskRecord): import("./envelope").AcceptanceState {
  return t.result?.acceptance ? t.result.acceptance.passed ? "passed" : "failed"
    : !t.brief.acceptance ? "none" : t.progress?.phase === "testing" ? "running" : "pending";
}
export function taskData(t:TaskRecord):TaskData & {title:string} {
  const last=t.attempts.at(-1); return {id:t.id,title:taskTitle(t),state:visibleTaskState(t),goal:clip(t.brief.goal,LIMITS.goal),executor:t.result?.executor??t.executor??last?.executor??null,backend:t.result?.backend??t.backend??null,worktree:t.result?.worktree??t.worktree??null,updatedAt:Math.max(t.createdAt,last?.startedAt??0,last?.endedAt??0,t.attemptStartedAt??0,t.reviewRequest?.at??0,t.stopPending?.requestedAt??0,t.question?.at??0,t.question?.answeredAt??0),
    ...(t.placement?.mode && t.placement.why!==undefined ? {placement:{mode:t.placement.mode,why:t.placement.why}} : {}),
    ...(t.question ? {question:t.question} : {}),
    ...(t.interactionMode ? {interactionMode:t.interactionMode} : {}),
    ...(t.conversation ? {conversation:t.conversation} : {}),
    acceptanceState: acceptanceState(t),
    ...(t.reviewRequest ? {reviewRequest:t.reviewRequest} : {}),
    ...(t.stopPending ? {stopPending:t.stopPending} : {}),
    ...(t.review?{review:t.review}:{}),...(t.resolved?{resolved:t.resolved}:{}),
    ...(t.dismissed ? {dismissed:true} : {}), ...(t.retryOf ? {retryOf:t.retryOf} : {}), ...(t.retriedBy ? {retriedBy:t.retriedBy} : {}),
    ...(t.result?.brokenReason ? {brokenExecutor:t.result.brokenExecutor,brokenReason:t.result.brokenReason} : {}),
    ...(t.attemptStartedAt ? {attemptStartedAt:t.attemptStartedAt} : {}),
    ...(t.progress && ["running","queued"].includes(t.state) ? {progress:{phase:t.progress.phase,lastOutputAt:t.progress.lastOutputAt,files:t.progress.files,commits:t.progress.commits,logBytes:t.progress.logBytes}} : {}),
    ...(["running","queued"].includes(t.state) ? {runnerAlive:!!t.runnerPid && pidAlive(t.runnerPid)} : {}),
    // Live events carry the diagnostics link, or a client upserting the event would forget the fix task.
    ...(t.diagnosticCheck ? {diagnosticCheck:t.diagnosticCheck} : {}),
    ...(t.diagnosticRecheck ? {diagnosticRecheck:t.diagnosticRecheck} : {}),
  };
}
export function entityDiff(prev:Record<string,string>,rows:{kind:EntityData["kind"];id:string;value:unknown}[]):{envelopes:OutboxEvent[];next:Record<string,string>} {
 const next:Record<string,string>={},envelopes:OutboxEvent[]=[];
 for(const row of rows){const key=`${row.kind}:${row.id}`,value=JSON.stringify(row.value);next[key]=value;if(prev[key]!==value)envelopes.push({type:"entity",data:{kind:row.kind,id:row.id,value:row.value}});}
 for(const key of Object.keys(prev))if(!Object.hasOwn(next,key)){const split=key.indexOf(":");envelopes.push({type:"entity",data:{kind:key.slice(0,split) as EntityData["kind"],id:key.slice(split+1),removed:true}});}
 return {envelopes,next};
}
const alert=(a:AlertData):OutboxEvent=>({type:"alert",data:a});
/** Cooperative-yield batch size for the per-task loop below; see its comment. */
const PUMP_YIELD_EVERY = 100;
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
    // Name only accounts that have a runner and a reading; "the executor unknown" tells nobody anything.
    const plannerPct = plannerAccount?.usedPct ?? planner?.binding?.usedPct;
    const parts = [...(plannerPct == null ? [] : [`planner ${Math.round(plannerPct)}%`]),
      ...refreshed.filter(a => a !== plannerAccount && a.runners.length > 0 && a.usedPct != null).map(a => `${executorName(a.runners[0])} ${Math.round(a.usedPct!)}%`)];
    if (parts.length) appendActivity(ctx, { kind: "budget_refreshed", level: "info", text: `Budgets refreshed · ${parts.join(" · ")}` });
  }
  if (JSON.stringify(prev) !== JSON.stringify(next)) writeJsonAtomic(path, next);
}

const pendingResolutions = new Map<string, Promise<TaskRecord>>();
async function pumpResolution(ctx: Ctx, task: TaskRecord): Promise<TaskRecord> {
  const key = join(ctx.pacerHome, task.id);
  let pending = pendingResolutions.get(key);
  if (!pending) {
    pending = resolveTask(ctx, task).finally(() => { pendingResolutions.delete(key); });
    pendingResolutions.set(key, pending);
  }
  return withTimeout(() => pending!, 250).catch(() => task);
}

/** Full-reconcile trigger for Lane 6's maintenance wiring: one full pass over every task plus
 *  the strategy/entity block, in addition to cursor 0, `gap:true` and the periodic cadence. */
export interface PumpOpts { reconcile?: boolean; ledger?: PumpLedgerApi }

/** Expensive periodic work (quota alerts, strategy fingerprints, host probes, entity
 *  diffs — spec §4) leaves the per-tick path: the bounded snapshot read model
 *  runs at most this often, and always on a full reconcile. A ~1 s tolerance keeps
 *  the cadence when the calling loop spent part of the interval in its own console
 *  terminal refresh before this tick started. */
const STRATEGY_PASS_SECONDS = 15;
const strategyPasses = new Map<string, number>();

/** Full-reconcile cadence inside pumpOnce (spec §3 safety net): the change log covers
 *  only what newer binaries write — same-revision JSON imports and pre-change-log
 *  settled-task edits arrive without a task_changes row, so one full pass runs at
 *  least this often, and always at startup (first tick), on a cursor `gap`, on an
 *  explicit request and when a full changes page queues up. */
const RECONCILE_SECONDS = 600;
/** A full reconcile walks the task table this many rows per page, yielding
 *  between pages, instead of decoding and Promise.all-resolving every record at once. */
const RECONCILE_PAGE = 200;
/** taskChangesSince page size used here: a page standing full means more than one
 *  page of work is queued, and a reconcile catches it up instead of 500 rows a tick. */
const CHANGES_PAGE = 500;

/** Full reconcile: pages of task IDs through the store.
 *  A dep that ignores the selected-id hint (the old shape) returns everything on
 *  its first call — processed once, exactly like before, and the loop stops. */
async function fullTasks(ctx:Ctx,deps:PumpDeps):Promise<TaskRecord[]>{
  const all:TaskRecord[]=[],seen=new Set<string>();
  let before:string|undefined;
  for(let first=true;;first=false){
    const page=taskIdPage(ctx,before,RECONCILE_PAGE);
    // The very first call may hit an empty store yet still must reach a custom dep (an
    // old-shape dep never reads the store). Later pages only fetch while rows remain.
    if(!first&&!page.length)break;
    const taken=new Set(page);
    const got=await Promise.all(deps.tasks(ctx,taken).map(t=>pumpResolution(ctx,t)));
    if(got.every(t=>t.id!==undefined&&taken.has(t.id))){
      for(const t of got)if(!seen.has(t.id)){seen.add(t.id);all.push(t);}
      if(!page.length)break;
      before=page[page.length-1]!; // IDs are newest first, like the store
      await new Promise<void>(done=>setImmediate(done));
    }else{
      // Old-shape dep: it handed over its complete list above; further pages would repeat it.
      for(const t of got)if(!seen.has(t.id)){seen.add(t.id);all.push(t);}
      break;
    }
  }
  return all;
}

export async function pumpOnce(ctx:Ctx,deps:PumpDeps=defaultPumpDeps,opts:PumpOpts={}) : Promise<OutboxEvent[]>{
  const ledger=opts.ledger??defaultLedgerApi;
  const lifecycleEvents:OutboxEvent[]=[];
  const agentRevision=agentSessionsRevision(ctx),agentSeen=join(ctx.pacerHome,'link','agent-sessions-seen.json');
  const priorAgentRevision=readJson<string>(agentSeen);
  if(priorAgentRevision!==agentRevision){
   if(priorAgentRevision!==null||agentRevision!==createHash('sha256').update('[]').digest('hex')){const event:OutboxEvent={type:'config',data:{area:'agent-sessions',at:ctx.now}};const report=await deps.publish(ctx,[event]);lifecycleEvents.push(event);if(report.transports.includes('outbox'))writeJsonAtomic(agentSeen,agentRevision);}
   else writeJsonAtomic(agentSeen,agentRevision);
  }

  // Expiry is independent of status refresh: even a failing provider must clear clients.
  const expiredEvents:OutboxEvent[]=[];
  const pausePath=join(ctx.pacerHome,"state","pause.json"),paused=readJson<PauseState>(pausePath);
  if(paused && typeof paused.until==="number" && Number.isFinite(paused.until) && paused.until<=ctx.now){
    const event:OutboxEvent={type:"pause",data:{removed:true}};
    const report=await deps.publish(ctx,[event]);
    if(report.transports.includes("outbox")){
      expiredEvents.push(event);
      // A new pause may have been written while publication awaited the link lock.
      if(JSON.stringify(readJson(pausePath))===JSON.stringify(paused))resume(ctx);
    }
  }
  rotateActivity(ctx);
  await drainQueue(ctx).catch(() => {});
  const latest=readLatest(ctx),out:OutboxEvent[]=[]; let st:Status;
  try{st=await deps.status(ctx);}catch(e){const body=clip(e instanceof Error?e.message:String(e),LIMITS.body),prev=latest.alerts.find(a=>a.key==="status-error");
    if(prev?.body!==body)out.push(alert({key:"status-error",level:"error",title:"Status could not be refreshed",body,error:body,at:ctx.now})); if(out.length)await deps.publish(ctx,out); return [...lifecycleEvents,...expiredEvents,...out];}
  const hold=readJson<{mode:string;until:number}>(join(ctx.pacerHome,"state","mode-hold.json"));
  const holdEndedPath=join(ctx.pacerHome,"state","mode-hold-ended.json");
  if(hold&&hold.until<=ctx.now&&readJson<number>(holdEndedPath)!==hold.until){
    appendActivity(ctx,{kind:"mode",level:"info",text:`Mode hold ended · back to ${modeName(st.mode)}`});
    writeJsonAtomic(holdEndedPath,hold.until);
  }
  statusActivity(ctx, st);
  const b=toBudget(st); if(budgetKey(b)!==budgetKey(latest.budget))out.push({type:"budget",data:b});
  const previous=latest.mode?.mode??null; if(previous!==b.mode){out.push({type:"mode",data:{mode:b.mode,previous,strategy:b.strategy,at:ctx.now}});if(previous!==null)out.push(alert({key:"mode",level:b.mode==="emergency"?"warn":"info",title:`Budget mode changed to ${b.mode}`,body:`${previous} -> ${b.mode} (strategy ${b.strategy})`,at:ctx.now}))}

  const workers=Object.values(loadOrcaState(ctx).workers), client=new OrcaClient(ctx.run,ctx.env);
  const workerTerminals=new Map<string,string>();
  for(const w of workers) if(w.taskId&&w.terminal) workerTerminals.set(w.taskId,w.terminal);

  // Selection (spec §3): change-log rows since the durable cursor plus the active set —
  // non-terminal tasks, tasks with a live worker record, session-registry entries and Orca
  // terminals. A full reconcile (every task, paged with yields) is the safety net: first
  // tick with nothing known, a cursor gap, an explicit request, a ten-minute cadence, or a
  // full page of pending changes.
  const cursor=ledger.readCursor(ctx);
  if(cursor===null)ledger.importLegacyLedgers(ctx);
  const {changes,head,gap}=taskChangesSince(ctx,cursor??0,CHANGES_PAGE);
  const lastReconcile=ledger.readReconcileAt(ctx);
  const reconcile=opts.reconcile===true||gap||changes.length>=CHANGES_PAGE
    ||lastReconcile===null||ctx.now<lastReconcile||ctx.now-lastReconcile>=RECONCILE_SECONDS
    ||(cursor===null&&ledger.isEmpty(ctx));
  const selected=new Set<string>();
  if(!reconcile){
    for(const change of changes)selected.add(change.taskId);
    for(const id of ledger.nonTerminalTaskIds(ctx))selected.add(id);
    for(const id of ledger.liveTaskIds(ctx))selected.add(id);
    for(const id of ledger.registryTaskIds(ctx))selected.add(id);
    for(const id of workerTerminals.keys())selected.add(id);
  }
  const memo=strategyPasses.get(ctx.pacerHome);
  const pass=reconcile||memo===undefined||ctx.now<memo||ctx.now-memo>=STRATEGY_PASS_SECONDS-1;
  if(pass)strategyPasses.set(ctx.pacerHome,ctx.now);
  // Periodic entity work uses the changed/active set plus a bounded snapshot,
  // while only reconciliation walks history. Union IDs before fetching to avoid
  // decoding active or changed records twice.
  const fetchIds = new Set(selected);
  if (pass && !reconcile) for (const id of snapshotTaskIds(ctx)) fetchIds.add(id);
  const all = reconcile ? await fullTasks(ctx,deps)
    : await Promise.all(deps.tasks(ctx,fetchIds).map(t=>pumpResolution(ctx,t)));
  const records = reconcile || !pass ? all : all.filter(t=>selected.has(t.id));
  if(pass)await withTimeout(()=>Promise.resolve((deps.backfillRepos??backfillRepos)(ctx,all.map(t=>t.brief.repo).filter((p):p is string=>typeof p==="string"))),250).catch(()=>{});
  let strategy:Strategy|undefined;
  try{strategy=(deps.strategy??loadStrategy)(ctx);}catch{/* No configured strategy yet. */}
  let policies: ProjectStrategyFile | undefined;
  try { policies = readProjectStrategies(ctx); } catch { /* Invalid policy must never produce a global retry suggestion. */ }
  // Retry suggestions are per-task policy readings; a non-pass tick computes them from the
  // selection so a settled task's transition alert keeps its exact shape.
  let policyTasks: ApiTask[] | undefined;
  let retryExecutors: ExecutorRow[] | undefined;
  const ledgerPrev=ledger.readLedger(ctx,records.map(t=>t.id));
  const known:Record<string,string|undefined>={},times:Record<string,number>={},seenData:Record<string,TaskData>={};
  for(const row of ledgerPrev.values()){
    if(row.state!==undefined)known[row.id]=row.state;
    if(row.eventAt!==undefined)times[row.id]=row.eventAt;
    if(row.data)seenData[row.id]=row.data;
  }
  const stateRows=new Set<string>(),dataRows=new Set<string>();
  let statesChanged=false;
  const terminals=await Promise.all(records.map(async t=>{
    const handle=workerTerminals.get(t.id);
    if(!handle)return false;
    try{return isLiveTerminal(await client.terminalShow(handle));}catch{return false;}
  }));
  // Each iteration's awaits (sessionTaskData -> sessionInfo) resolve without ever reaching
  // real I/O for most historical tasks, so they never yield to the macrotask queue; a tick
  // with thousands of tasks ran this whole loop as one uninterrupted stretch and blocked
  // concurrent requests (desktop heartbeat, event stream) for hundreds of ms. Yielding every
  // 100 tasks keeps each stretch short without changing any result (PUMP_YIELD_EVERY tasks is
  // an arbitrary batch size, not a behavior change).
  const nextData:Record<string,TaskData>={};
  const keepSessions=new Set<string>(),dropSessions=new Set<string>();
  let settledThisTick=false;
  for(const [index,t] of records.entries()){
    if(index>0 && index%PUMP_YIELD_EVERY===0) await new Promise<void>(done=>setImmediate(done));
    const d=await sessionTaskData(ctx,taskData(t),terminals[index]),prev=latest.tasks.find(x=>x.id===d.id)??seenData[d.id],before=known[d.id]??prev?.state;
    // Session and terminal state is the second change source (spec §3): a settled task
    // stays in the active set only while its session is actually live — the 14-day
    // runs/<id>/<n> history must not keep every past builtin session pumping forever.
    (d.terminalPresent===true||d.session?.live===true||workerTerminals.has(t.id)?keepSessions:dropSessions).add(t.id);
    if(known[d.id]!==d.state){known[d.id]=d.state;statesChanged=true;stateRows.add(d.id);}
    if(prev && Object.keys({...prev,...d}).every(k=>JSON.stringify(prev[k as keyof TaskData])===JSON.stringify(d[k as keyof TaskData])))continue;
    // Coalesce progress-only changes; state transitions always publish immediately.
    if(prev && prev.state===d.state && Object.keys({...prev,...d}).filter(k=>k!=="progress").every(k=>JSON.stringify(prev[k as keyof TaskData])===JSON.stringify(d[k as keyof TaskData])) && ctx.now-(times[d.id]??-Infinity)<1)continue;
    out.push({type:"task",data:d});times[d.id]=ctx.now;nextData[d.id]=d;dataRows.add(d.id);
    const terminal=TERMINAL_STATES.includes(d.state as TaskState);
    if(terminal&&d.state!=="needs_input"&&before!==d.state&&(before!==undefined||latest.seq>0)) {
      settledThisTick=true;
      const last=t.attempts.at(-1), name=executorName(d.executor);
      let next: string|null=null;
      if(strategy && policies){policyTasks??=apiTasks(ctx,records);retryExecutors??=buildExecutors(st,strategy,policyTasks,ctx.now,ctx);next=retryTargetFor(policyTasks[index]!,strategy,retryExecutors,policies);}
      const kind=d.state==="done"?"done":"failed";
      // A pending provider stop is recorded only when the exact wrapper exit settles it.
      if (d.state === "stopped" && t.executorProvider && t.executorExitReceipt) appendActivity(ctx, {
        kind: "task_settled", level: "info", text: `Stopped “${taskTitle(t)}”`,
        ...(t.brief.repo ? { repo: (t.repo ?? repoFor(ctx, t.brief.repo)).key } : {}), taskId: t.id,
        ...(d.executor ? { executor: d.executor } : {}),
      });
      else if (d.state !== "stopped") appendActivity(ctx, {
        kind: "task_settled", level: d.state === "done" ? "info" : "warn",
        text: d.state === "done" ? `${name} finished “${taskTitle(t)}”` : `${name} failed “${taskTitle(t)}”`,
        ...(t.brief.repo ? { repo: (t.repo ?? repoFor(ctx, t.brief.repo)).key } : {}), taskId: t.id,
        ...(d.executor ? { executor: d.executor } : {}), ...(t.run?.host ? { host: t.run.host } : {}),
      });
      if(kind!=="done"||t.fromPanel||((last?.endedAt??ctx.now)-t.createdAt)>600) out.push(alert({key:`task-${d.id}`,level:kind==="failed"?"warn":"info",title:`Task ${kind} on ${name}`,body:`${shortGoal(d.goal)}\n${kind==="done"?"Nothing to do.":next?`Open the pacer panel to retry on ${executorName(next)}.`:"Open the pacer panel to retry."}`,at:ctx.now,notification:{kind,fromPanel:t.fromPanel===true,executor:d.executor??undefined,goal:d.goal,...(next?{nextExecutor:next}:{})}}));
      const broken=t.attempts.find(a=>a.brokenReason);
      if(broken)out.push(alert({key:`broken-${broken.executor}-${d.id}`,level:"warn",title:`${executorName(broken.executor)} isn't starting`,body:`${shortGoal(d.goal)}\n${d.executor&&d.executor!==broken.executor?`Moved to ${executorName(d.executor)} automatically.`:"Open the pacer panel to retry."}`,at:ctx.now,notification:{kind:"broken",executor:broken.executor,goal:d.goal,...(d.executor&&d.executor!==broken.executor?{nextExecutor:d.executor}:{})}}));
    }
  }
  // Expensive periodic work (spec §4): quota alerts and strategy fingerprints run on the
  // pass cadence, aligned with the read-model work that also needs every task. The quota
  // comparison itself runs every tick: latest.budget updates each tick, so a verdict
  // change (ON_PACE -> NEAR_LIMIT) that lands on a non-pass tick must alert before the
  // next pass would otherwise see no change. It reads one small JSON file.
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
  const seenPath=join(ctx.pacerHome,"link","strategy-seen.json");
  let previousSeen:unknown,next:Record<string,string>|undefined;
  if(pass){
    previousSeen=readJson<unknown>(seenPath);
    const entries=list(ctx);
  // Accept the old name-only ledger as a baseline, then persist content fingerprints.
    const seen:Record<string,unknown>|null=Array.isArray(previousSeen) ? Object.fromEntries(previousSeen.map(name=>[name,null])) : isObj(previousSeen) ? previousSeen : null;
    next={};
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
  }
  const report=out.length ? await deps.publish(ctx,out) : null;
  // Publish bookkeeping stays ordered after a successful outbox publish: ledger rows
  // first, then the registry and cursor last, so a crash between them replays changes
  // instead of skipping them and replays nothing duplicated (the rows describe what
  // was published). Nothing between the ledger rows and the cursor may throw first:
  // registry bookkeeping runs only after a cursor write succeeded.
  const reportOk=!report || report.transports.includes("outbox");
  if(reportOk && (statesChanged||dataRows.size)){
    const ledgerRows=new Map<string,LedgerRow>();
    for(const id of stateRows)ledgerRows.set(id,{id,state:known[id]});
    for(const id of dataRows){const row=ledgerRows.get(id)??{id};row.data=nextData[id];row.eventAt=times[id];ledgerRows.set(id,row);}
    ledger.writeLedger(ctx,ledgerRows.values());
  }
  const nextCursor=reconcile?head:changes.length?changes[changes.length-1]!.seq:head;
  if(reportOk && (cursor===null||nextCursor!==(cursor??-Infinity)))ledger.writeCursor(ctx,nextCursor);
  if(reportOk && reconcile)ledger.writeReconcileAt(ctx,ctx.now); // a completed full pass schedules the next one
  if(reportOk)ledger.writeSessions(ctx,[...keepSessions],[...dropSessions]);
  if(reportOk && (reconcile||settledThisTick))ledger.writeLegacyLedgers(ctx); // rollback bridge: JSON ledgers stay true
  if(pass && strategy){
    const probePath=join(ctx.pacerHome,"state","host-probe-at.json"),lastProbe=readJson<number>(probePath);
    if(lastProbe===null||ctx.now<lastProbe||ctx.now-lastProbe>=300){
      await (deps.probeHosts??probeHosts)(ctx,{strategy:()=>strategy!});
      writeJsonAtomic(probePath,ctx.now);
    }
    const context=deps.setup?{setup:await deps.setup(ctx),accounts:[]}:await readModelContext(ctx);
    const model=buildReadModel(ctx,{status:st,strategy,tasks:snapshotTasks(ctx,all),setup:context.setup,hosts:Object.values(strategy.hosts),signedIn:context.accounts});
    out.push(...await dispatchNotifications(ctx,model.attention,{publish:deps.publish,events:[...out]}));
    const rows:{kind:EntityData["kind"];id:string;value:unknown}[]=[
      {kind:"planner",id:"planner",value:model.planner},
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
      const entities=await deps.publish(ctx,diff.envelopes);out.push(...diff.envelopes);
      if(entities.transports.includes("outbox")){writeJsonAtomic(path,diff.next);if(diff.envelopes.some(e=>e.type==="entity"&&e.data.kind==="counts"))writeJsonAtomic(countsPath,ctx.now);}
    }
  }
  if(quotaChanged && report?.transports.includes("outbox"))writeJsonAtomic(quotaPath,quotaSeen);
  // Only acknowledge changes after the durable alert reached the link outbox.
  if(pass && next && (!report || report.transports.includes("outbox")) && JSON.stringify(previousSeen)!==JSON.stringify(next))writeJsonAtomic(seenPath,next);
  return [...lifecycleEvents,...expiredEvents,...out];
}
