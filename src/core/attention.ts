import type { Ctx } from "../types";
import { loadStrategy } from "../config/strategy";
import { computeStatus } from "../engine/status";
import { listActiveAndRecentTasks } from "../tasks/store";
import { isEngineOwnedKind } from "../tasks/engine-owned";
import { taskRecordStatus } from "../tasks/api";
import { snapshotTasks } from "../api/read-model/tasks";
import { buildExecutors, buildAccounts, buildPlanner } from "../api/read-model/capacity";
import { buildSetup } from "../api/read-model/summary";
import { readModelContext, retryTargetFor } from "../api/read-model";
import { deriveTaskItems as deriveItems } from "./task-attention";
import { dismissItem, snoozeItem } from "../attention/store";
import { dismiss as dismissTasks } from "./tasks";
import { discoveryRuleInput } from "../discovery/prompts";
import { deriveWorkflowAttention } from "../workflow/attention";
import { workflowDatabase } from "../workflow/store";

/** Ordinary attention never surfaces engine-owned tasks (D2.12). */
function attentionTasks(ctx: Ctx) {
  return listActiveAndRecentTasks(ctx).filter(t => !isEngineOwnedKind(t.kind));
}

/** Asker task ids with an open structured question — suppress the ordinary question item (I6). */
function openQuestionAskerIds(ctx: Ctx): Set<string> {
  try {
    const rows = workflowDatabase(ctx).query<{ asker_task_id: string | null }, []>(
      "SELECT asker_task_id FROM workflow_questions WHERE status = 'open' AND asker_task_id IS NOT NULL",
    ).all();
    return new Set(rows.map(r => r.asker_task_id!).filter(Boolean));
  } catch {
    return new Set();
  }
}

function mergeAttention(ctx: Ctx, ordinary: ReturnType<typeof deriveItems>) {
  const askers = openQuestionAskerIds(ctx);
  const filtered = ordinary.filter(i => !(i.kind === "question" && i.taskId && askers.has(i.taskId)));
  return [...filtered, ...deriveWorkflowAttention(ctx)];
}

async function raisedItems(ctx: Ctx) {
  let strategy;
  try { strategy=loadStrategy(ctx); } catch {
    const context=await readModelContext(ctx);
    const tasks = snapshotTasks(ctx, attentionTasks(ctx).map(t => taskRecordStatus(ctx, t)));
    return mergeAttention(ctx, deriveItems({now:ctx.now,tasks,executors:[],accounts:[],planner:null,setup:buildSetup(context.setup),update:null,retryTarget:()=>null,discovery:discoveryRuleInput(ctx,ctx.now)}));
  }
  const [status,context]=await Promise.all([computeStatus({...ctx,readOnly:true},strategy),readModelContext(ctx)]);
  const tasks=snapshotTasks(ctx,attentionTasks(ctx).map(t=>taskRecordStatus(ctx,t)));
  const executors=buildExecutors(status,strategy,tasks,ctx.now);
  const accounts=buildAccounts(status,strategy,ctx);
  return mergeAttention(ctx, deriveItems({now:ctx.now,tasks,executors,accounts,planner:buildPlanner(status),setup:buildSetup(context.setup),update:null,retryTarget:t=>retryTargetFor(t,strategy,executors),discovery:discoveryRuleInput(ctx,ctx.now)}));
}
export async function dismiss(ctx: Ctx, id: string) {
  let pending: ReturnType<typeof dismissTasks> | undefined;
  const result = dismissItem(ctx,id,await raisedItems(ctx),item=>{if(item.taskId)pending=dismissTasks(ctx,[item.taskId]);});
  await pending;
  return result;
}
export async function snooze(ctx: Ctx, id: string, duration: "1h" | "4h" | "1d") {
  return snoozeItem(ctx,id,duration,await raisedItems(ctx));
}
