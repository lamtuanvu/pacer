import type { Ctx } from "../types";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { listActiveAndRecentTasks } from "../tasks/store";
import { taskRecordStatus } from "../tasks/api";
import { snapshotTasks } from "../api/read-model/tasks";
import { buildExecutors, buildAccounts, buildPlanner } from "../api/read-model/capacity";
import { buildSetup } from "../api/read-model/summary";
import { readModelContext, retryTargetFor } from "../api/read-model";
import { deriveTaskItems as deriveItems } from "./task-attention";
import { dismissItem, snoozeItem } from "../attention/store";
import { dismiss as dismissTasks } from "./tasks";
import { discoveryRuleInput } from "../discovery/prompts";

async function raisedItems(ctx: Ctx) {
  let strategy;
  try { strategy=loadStrategy(ctx); } catch {
    const context=await readModelContext(ctx);
    return deriveItems({now:ctx.now,tasks:snapshotTasks(ctx,listActiveAndRecentTasks(ctx).map(t=>taskRecordStatus(ctx,t))),executors:[],accounts:[],planner:null,setup:buildSetup(context.setup),update:null,retryTarget:()=>null,discovery:discoveryRuleInput(ctx,ctx.now)});
  }
  const [status,context]=await Promise.all([computeStatus({...ctx,readOnly:true},strategy),readModelContext(ctx)]);
  const tasks=snapshotTasks(ctx,listActiveAndRecentTasks(ctx).map(t=>taskRecordStatus(ctx,t)));
  const executors=buildExecutors(status,strategy,tasks,ctx.now);
  const accounts=buildAccounts(status,strategy,ctx);
  return deriveItems({now:ctx.now,tasks,executors,accounts,planner:buildPlanner(status),setup:buildSetup(context.setup),update:null,retryTarget:t=>retryTargetFor(t,strategy,executors),discovery:discoveryRuleInput(ctx,ctx.now)});
}
export async function dismiss(ctx: Ctx, id: string) {
  return dismissItem(ctx,id,await raisedItems(ctx),item=>{if(item.taskId)dismissTasks(ctx,[item.taskId]);});
}
export async function snooze(ctx: Ctx, id: string, duration: "1h" | "4h" | "1d") {
  return snoozeItem(ctx,id,duration,await raisedItems(ctx));
}
