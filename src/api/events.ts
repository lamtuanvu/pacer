import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import { currentSnapshot, readOutboxSince } from "../link/store";
import type { LinkSnapshot } from "../link/envelope";
import { toBudget } from "../link/budget";
import { apiTask, snapshotTasks } from "./read-model/tasks";
import { buildReadModel, readModelContext } from "./read-model";
import type { ReadModelFields, ApiTask } from "./read-model/types";
import { listTasks, readTask } from "../tasks/store";
import { taskStatus } from "../tasks/api";
import { computeStatus, type Status } from "../engine/status";
import { loadStrategy, validateStrategy } from "../config/strategy";
import type { Ctx } from "../types";
import { type ApiEvent, PROTOCOL_VERSION } from "./protocol";

export function apiSnapshot(ctx: Ctx): { protocol: string; seq: number; snapshot: LinkSnapshot } {
  const snapshot = currentSnapshot(ctx);
  return { protocol: PROTOCOL_VERSION, seq: snapshot.seq, snapshot };
}

const statusCache=new Map<string,{at:number;strategy:string;value:Status}>();
export async function liveSnapshot(
  ctx: Ctx, o: { maxBudgetAgeS?: number; status?: (c: Ctx) => Promise<Status> } = {},
): Promise<{ protocol: string; seq: number; snapshot: LinkSnapshot & ReadModelFields & {tasks:ApiTask[]} }> {
  const snapshot = currentSnapshot(ctx);
  // Only records the snapshot can show need a live status read; the rest are settled history.
  const recent = (t: TaskRecord) => !TERMINAL_STATES.includes(t.state) || Math.max(t.createdAt, t.attemptStartedAt ?? 0, ...t.attempts.map(a => a.endedAt ?? 0)) >= ctx.now - 86400;
  const tasks = snapshotTasks(ctx,listTasks(ctx,Infinity).filter(recent).map(t=>taskStatus(ctx,t.id)??t));
  snapshot.tasks = tasks.map(t=>({...snapshot.tasks.find(old=>old.id===t.id),...t}));
  let strategy;
  try{strategy=loadStrategy(ctx);}catch{
    strategy=validateStrategy({planner:"claude-code",providers:{"claude-code":{}}},"snapshot");
    strategy.runners={};strategy.accounts={};strategy.providers={};strategy.routing=[];
  }
  const status = o.status ?? (c => computeStatus({ ...c, readOnly: true }, strategy));
  const key=JSON.stringify(strategy),cached=statusCache.get(ctx.pacerHome);
  let statusAvailable=false;
  const refresh=async():Promise<Status>=>{
    if(!o.status && cached && cached.strategy===key && ctx.now-cached.at>=0 && ctx.now-cached.at< (o.maxBudgetAgeS??60)){statusAvailable=true;return cached.value;}
    try{const value=await status(ctx);statusAvailable=true;statusCache.set(ctx.pacerHome,{at:ctx.now,strategy:key,value});return value;}
    catch{return {generatedAt:ctx.now,strategy:strategy.name,planner:snapshot.budget?.planner??Object.keys(strategy.runners).find(id=>strategy.runners[id].agent===strategy.planner.agent&&strategy.runners[id].account===strategy.planner.account)??"",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}};}
  };
  const [st,context]=await Promise.all([refresh(),readModelContext(ctx)]);
  if (statusAvailable && (!snapshot.budget || ctx.now - snapshot.budget.generatedAt > (o.maxBudgetAgeS ?? 60))) snapshot.budget = toBudget(st);
  const fields=buildReadModel(ctx,{status:st,strategy,tasks,setup:context.setup,hosts:Object.values(strategy.hosts),signedIn:context.accounts});
  const result={...snapshot,...fields,tasks:snapshot.tasks as ApiTask[]};
  return { protocol: PROTOCOL_VERSION, seq: snapshot.seq, snapshot: result };
}

export function eventsSince(ctx: Ctx, since: number): { events: ApiEvent[]; last: number; reset: boolean } {
  const all = readOutboxSince(ctx, 0);
  const oldest = all[0]?.seq;
  const reset = since > 0 && oldest !== undefined && oldest > since + 1;
  const after = all.filter((e) => e.seq > since);
  const events: ApiEvent[] = [
    ...(reset ? [{ seq: oldest! - 1, at: ctx.now, type: "reset" as const, data: { reason: "events were dropped; fetch the snapshot again" } }] : []),
    ...after.map((e): ApiEvent => {
      const env=e.envelope;
      let data:unknown=env.data;
      if(env.type==="entity")data=env.data.removed?{id:env.data.id,removed:true}:env.data.value;
      if(env.type==="task"){
        const record=readTask(ctx,env.data.id);
        if(record){const {repo,kind,host}=apiTask(ctx,record);data={...env.data,repo,kind,host};}
      }
      return {seq:e.seq,at:e.at??ctx.now,type:env.type==="entity"?env.data.kind:env.type,data};
    }),
  ];
  return { events, last: after.at(-1)?.seq ?? since, reset };
}
