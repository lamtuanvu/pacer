import { V2_STATE, V2_EVENT, V2_PROTOCOL, V3_CURSOR_BASE, toV2Snapshot, toV2Event, type CompatEvent } from "./v2-compat";
import type { SnapshotV3 } from "./read-model/types";
import { buildPlanner } from "./read-model/capacity";
import { fullTaskTitle, shortTitle } from "../core/short-title";
import { readHold } from "../core/mode-hold";
import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import { currentSnapshot, readOutboxSince } from "../link/store";
import { toBudget } from "../link/budget";
import { apiTasks, snapshotTasks } from "./read-model/tasks";
import { buildReadModel, readModelContext } from "./read-model";
import type { ApiTask } from "./read-model/types";
import { listTasksWhere, readTask, taskStoreVersion } from "../tasks/store";
import { computeStatus, type Status } from "../engine/status";
import { loadStrategy, validateStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { type ApiEvent, PROTOCOL_VERSION } from "./protocol";

/** The canonical snapshot is the negotiated v3 read model. */
export async function apiSnapshot(ctx: Ctx) { return liveSnapshot(ctx); }

const taskCache = new Map<string, { version: string; at: number; records: TaskRecord[] }>();
const statusCache=new Map<string,{at:number;strategy:string;value:Status}>();
export async function liveSnapshot(
  ctx: Ctx, o: { maxBudgetAgeS?: number; status?: (c: Ctx) => Promise<Status> } = {},
): Promise<{ protocol: string; seq: number; snapshot: SnapshotV3 }> {
  const snapshot = currentSnapshot(ctx);
  const version = taskStoreVersion(ctx), cachedTasks = taskCache.get(ctx.pacerHome);
  let records: TaskRecord[];
  if (cachedTasks?.version === version && ctx.now >= cachedTasks.at) records = cachedTasks.records;
  else {
    const selected = new Map(listTasksWhere(ctx, { updatedSince: ctx.now - 86400 }).map(t => [t.id, t]));
    for (const t of listTasksWhere(ctx, { states: ["queued", "running"] })) selected.set(t.id, t);
    records = [...selected.values()].sort((a, b) => b.id.localeCompare(a.id));
    taskCache.set(ctx.pacerHome, { version, at: ctx.now, records });
  }
  // Age settled records out of the cached selection on every read.
  const recent = (t: TaskRecord) => !TERMINAL_STATES.includes(t.state) || Math.max(t.createdAt, t.attemptStartedAt ?? 0, ...t.attempts.map(a => a.endedAt ?? 0)) >= ctx.now - 86400;
  const tasks = snapshotTasks(ctx, records.filter(recent));
  snapshot.tasks = tasks.map(t=>({...snapshot.tasks.find(old=>old.id===t.id),...t}));
  let strategy;
  try{strategy=loadStrategy(ctx);}catch{
    strategy=validateStrategy({planner:"claude-code",providers:{"claude-code":{}}},"snapshot");
    strategy.runners={};strategy.accounts={};strategy.providers={};strategy.routing=[];
  }
  const status = o.status ?? (c => computeStatus({ ...c, readOnly: true }, strategy));
  const key=JSON.stringify([strategy,readHold(ctx)]),cached=statusCache.get(ctx.pacerHome);
  let statusAvailable=false,warming=false;
  const refresh=async():Promise<Status>=>{
    if(!o.status && cached && cached.strategy===key && ctx.now-cached.at>=0 && ctx.now-cached.at< (o.maxBudgetAgeS??60)){statusAvailable=true;return cached.value;}
    try{const value=await status(ctx);statusAvailable=true;statusCache.set(ctx.pacerHome,{at:ctx.now,strategy:key,value});return value;}
    catch(e){warming=e instanceof Error&&e.message==="status is warming up";return {generatedAt:ctx.now,strategy:strategy.name,planner:snapshot.budget?.planner??Object.keys(strategy.runners).find(id=>strategy.runners[id].agent===strategy.planner.agent&&strategy.runners[id].account===strategy.planner.account)??"",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}};}
  };
  const [st,context]=await Promise.all([refresh(),readModelContext(ctx)]);
  if (statusAvailable && (!snapshot.budget || ctx.now - snapshot.budget.generatedAt > (o.maxBudgetAgeS ?? 60))) snapshot.budget = toBudget(st);
  const fields=buildReadModel(ctx,{status:st,strategy,tasks,setup:context.setup,hosts:Object.values(strategy.hosts),signedIn:context.accounts});
  // While the first status is still being computed, say so instead of making clients wait for it.
  if(warming)fields.service={...fields.service,starting:true};
  const result:SnapshotV3={seq:V3_CURSOR_BASE+snapshot.seq,at:snapshot.at,mode:snapshot.mode,...fields,tasks:snapshot.tasks as ApiTask[],strategies:snapshot.strategies??[]};
  // Legacy-only transport state must survive the overlap without appearing on v3 wires.
  Object.defineProperty(result,V2_STATE,{value:{budget:snapshot.budget,alerts:snapshot.alerts,console:snapshot.console,consoles:snapshot.consoles,serviceInstalled:snapshot.serviceInstalled}});
  return { protocol: PROTOCOL_VERSION, seq: result.seq, snapshot: result };
}

function legacyEventsSince(ctx: Ctx, since: number): { events: ApiEvent[]; last: number; reset: boolean } {
  const all = readOutboxSince(ctx, 0);
  const oldest = all[0]?.seq;
  const reset = since > 0 && oldest !== undefined && oldest > since + 1;
  const after = all.filter((e) => e.seq > since);
  // Enrich task events in one batch: per-event apiTask re-reads every task file for repo
  // labels, which made a replay from cursor 0 O(events × tasks) and blocked the service.
  const ids = [...new Set(after.flatMap(e => e.envelope.type === "task" ? [e.envelope.data.id] : []))];
  const records = ids.map(id => readTask(ctx, id)).filter((t): t is TaskRecord => t !== null);
  const enriched = new Map(apiTasks(ctx, records).map(t => [t.id, t]));
  const events: ApiEvent[] = [
    ...(reset ? [{ seq: oldest! - 1, at: ctx.now, type: "reset" as const, data: { reason: "events were dropped; fetch the snapshot again" } }] : []),
    ...after.map((e): ApiEvent => {
      const env=e.envelope;
      let data:unknown=env.data;
      if(env.type==="entity")data=env.data.removed?{id:env.data.id,removed:true}:env.data.value;
      if(env.type==="task"){
        data={...env.data,title:env.data.title || shortTitle(env.data.goal),fullTitle:fullTaskTitle({title:env.data.title,brief:{goal:env.data.goal}})};
        const task=enriched.get(env.data.id);
        if(task){const {repo,kind,host,title,fullTitle}=task;data={...env.data,repo,kind,host,title,fullTitle};}
      }
      return {seq:e.seq,at:e.at??ctx.now,type:env.type==="entity"?env.data.kind:env.type,data};
    }),
  ];
  return { events, last: after.at(-1)?.seq ?? since, reset };
}


export async function liveV2Snapshot(ctx:Ctx,o:Parameters<typeof liveSnapshot>[1]={}) {
 const result=await liveSnapshot(ctx,o),snapshot=toV2Snapshot(result.snapshot);
 return {protocol:V2_PROTOCOL,seq:snapshot.seq,snapshot};
}

/** Default 2 preserves the in-repo legacy clients during the overlap. */
export function eventsSince(ctx:Ctx,since:number,protocol:2|3=2):{events:ApiEvent[];last:number;reset:boolean} {
 const oldCursor=protocol===3&&since>0&&since<V3_CURSOR_BASE;
 const rawSince=protocol===3?(since>=V3_CURSOR_BASE?since-V3_CURSOR_BASE:0):since;
 const batch=legacyEventsSince(ctx,rawSince);
 const converted:CompatEvent[]=batch.events.map(e=>{
  const seq=V3_CURSOR_BASE+e.seq;
  let event:CompatEvent;
  if(e.type==='budget') {
   const b=e.data as import('../link/envelope').BudgetData;
   // Executor and account rows are published separately by the read-model pump.
   const st:Status={generatedAt:b.generatedAt,strategy:b.strategy,planner:b.planner,mode:b.mode as Status['mode'],disabled:false,calendarPace:false,executors:{ranked:[],excluded:[]},providers:b.providers.map(p=>({...p,usage:'quota',installed:true,windows:[],verdict:p.verdict as import('../types').Verdict,binding:p.usedPct===null?null:{name:p.window??'unknown',lengthS:0,paced:true,usedPct:p.usedPct,pace:p.pacePct??undefined,resetsAt:p.resetsAt,verdict:p.verdict as import('../types').Verdict}}))};
   event={...e,seq,type:'planner',data:buildPlanner(st)};
  } else if(e.type==='alert') {
   const a=e.data as import('../link/envelope').AlertData;
   event={...e,seq,type:'notify',data:{key:`${a.key}:${a.at}`,title:a.title,body:a.body,actions:[],url:'/app/#/'}};
  } else event={...e,seq,type:e.type};
  Object.defineProperty(event,V2_EVENT,{value:e.type==="planner"||e.type==="desktop.update"?null:e});
  return event;
 });
 if(protocol===2)return {...batch,events:converted.map(toV2Event).filter(e=>e!==null)};
 if(oldCursor)converted.unshift({seq:V3_CURSOR_BASE+rawSince,at:ctx.now,type:'reset',data:{reason:'protocol changed; fetch the snapshot again'}});
 return {events:converted,last:V3_CURSOR_BASE+batch.last,reset:oldCursor||batch.reset};
}
