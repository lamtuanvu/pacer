import { loadStrategy } from "../config/strategy";
import { type Status, computeStatus } from "../engine/status";
import { taskStatus } from "../tasks/api";
import { listTasks } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord, type TaskState } from "../tasks/types";
import type { Ctx } from "../types";
import { budgetKey, toBudget } from "./budget";
import { type AlertData, type Envelope, LIMITS, type TaskData, clip } from "./envelope";
import { type PublishReport, publish } from "./publish";
import { readLatest } from "./store";
export interface PumpDeps { status(ctx:Ctx):Promise<Status>; tasks(ctx:Ctx):TaskRecord[]; publish(ctx:Ctx,envs:Envelope[]):Promise<PublishReport> }
export const defaultPumpDeps:PumpDeps={status:ctx=>computeStatus(ctx,loadStrategy(ctx)),tasks:ctx=>listTasks(ctx,LIMITS.tasks).map(t=>taskStatus(ctx,t.id)??t),publish:(ctx,envs)=>publish(ctx,envs)};
export function taskData(t:TaskRecord):TaskData {
  const last=t.attempts.at(-1); return {id:t.id,state:t.state,goal:clip(t.brief.goal,LIMITS.goal),executor:t.result?.executor??last?.executor??null,backend:t.result?.backend??null,worktree:t.result?.worktree??null,updatedAt:Math.max(t.createdAt,last?.startedAt??0,last?.endedAt??0)};
}
const alert=(a:AlertData):Envelope=>({v:1,type:"alert",data:a});
export async function pumpOnce(ctx:Ctx,deps:PumpDeps=defaultPumpDeps):Promise<Envelope[]> {
  const latest=readLatest(ctx),out:Envelope[]=[]; let st:Status;
  try{st=await deps.status(ctx);}catch(e){const body=clip(e instanceof Error?e.message:String(e),LIMITS.body),prev=latest.alerts.find(a=>a.key==="status-error");
    if(prev?.body!==body)out.push(alert({key:"status-error",level:"error",title:"pacer status failed",body,error:body,at:ctx.now})); if(out.length)await deps.publish(ctx,out); return out;}
  const b=toBudget(st); if(budgetKey(b)!==budgetKey(latest.budget))out.push({v:1,type:"budget",data:b});
  const previous=latest.mode?.mode??null; if(previous!==b.mode){out.push({v:1,type:"mode",data:{mode:b.mode,previous,strategy:b.strategy,at:ctx.now}});if(previous!==null)out.push(alert({key:"mode",level:b.mode==="emergency"?"warn":"info",title:`pacer mode: ${b.mode}`,body:`${previous} -> ${b.mode} (strategy ${b.strategy})`,at:ctx.now}));}
  for(const t of deps.tasks(ctx)){const d=taskData(t),prev=latest.tasks.find(x=>x.id===d.id);if(prev?.state===d.state)continue;out.push({v:1,type:"task",data:d});
    const terminal=TERMINAL_STATES.includes(d.state as TaskState);if(terminal&&(prev||latest.seq>0))out.push(alert({key:`task-${d.id}`,level:d.state==="failed"||d.state==="limit"?"warn":"info",title:clip(`pacer task ${d.state}: ${d.goal}`,LIMITS.title),body:clip(`${d.executor??"-"} via ${d.backend??"-"}${d.worktree?` in ${d.worktree}`:""}`,LIMITS.body),at:ctx.now}));}
  if(out.length)await deps.publish(ctx,out); return out;
}
