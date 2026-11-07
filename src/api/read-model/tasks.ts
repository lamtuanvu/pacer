import { activeAgentSessions } from "../../session/agents-state";
import { fullTaskTitle } from "../../core/short-title";
import { repoFor, registeredRepo, listRepos, labelsFor } from "../../core/repos";
import { taskData } from "../../link/pump";
import type { TaskData } from "../../link/envelope";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import { unreadCounts } from "../../messaging/store";
import { getLiveness, listLiveness, type LivenessRow } from "../../messaging/liveness-store";
import { parentOfTask } from "../../messaging/participants";
import type { ApiTask } from "./types";

type UnreadCounts = ReturnType<typeof unreadCounts>;
/** apiTasks batches this once (listLiveness) instead of two SELECTs per task (own + parent). */
type LivenessLookup = (node: string) => LivenessRow | null;
export function apiTask(ctx: Ctx,t: TaskRecord, repoLabels?: Map<string,string>, counts?: UnreadCounts, activeCount?:number, liveness?: LivenessLookup): ApiTask {
 const unread=(counts??unreadCounts(ctx,"human",[t.id])).get(t.id);
 const lookupLiveness=liveness??(node=>getLiveness(ctx,node));
 // parentOfTask(ctx,t), not parentOf(ctx,`task:${t.id}`): t is already a fresh read of this
 // exact record, so this skips a second store lookup of it (see parentOfTask's comment).
 const own=lookupLiveness(`task:${t.id}`), parent=parentOfTask(ctx,t), parentRow=parent?lookupLiveness(parent):null;
 const live=own?.reason?own:parentRow?.reason&&parentRow.escalatedAt?parentRow:null;
 const repo=t.repo??registeredRepo(ctx,t.brief.repo)??{...repoFor(ctx,t.brief.repo),identityUnverified:true as const},labels=repoLabels??labelsFor([...listRepos({...ctx,readOnly:true}),repo]);
 const active=activeCount??activeAgentSessions(ctx).filter(s=>s.task_id===t.id).length;
 return {...taskData(t),...(active?{activeAgentSessions:active}:{}),...(t.archived?{archived:true,archivePath:t.archivePath}:{}),fullTitle:fullTaskTitle(t),...(t.question?{question:t.question}:{}),rev:t.rev,queue:t.queue??null,...(t.source?{source:t.source}:{}),repo:{...repo,label:labels.get(repo.key)!},kind:t.kind??null,host:t.run?.host??null,...(t.diagnosticCheck?{diagnosticCheck:t.diagnosticCheck}:{}),...(t.diagnosticRecheck?{diagnosticRecheck:t.diagnosticRecheck}:{}),...(live?{liveness:{stalled:!!live.stalledAt,reason:live.reason,...(live.node!==`task:${t.id}`?{waitingOn:live.node}:{}),since:live.since}}:{}),...(unread?{messages:{unreadForHuman:unread.unread,...(unread.question?{question:{id:unread.question.id,text:unread.question.body.slice(0,1000),at:unread.question.createdAt}}:{})}}:{})};
}
/** Batch labels once: apiTask alone reads task-backed repository labels. */
export function apiTasks(ctx: Ctx, records: TaskRecord[]): ApiTask[] {
 const repos=records.map(t=>t.repo??registeredRepo(ctx,t.brief.repo)??{...repoFor(ctx,t.brief.repo),identityUnverified:true as const});
 const labels=labelsFor([...listRepos({...ctx,readOnly:true},repos),...repos]);
 const counts=unreadCounts(ctx,"human",records.map(t=>t.id));
 const active=new Map<string,number>();
 for(const s of activeAgentSessions(ctx))active.set(s.task_id,(active.get(s.task_id)??0)+1);
 // One SELECT for every node instead of up to two (own + parent) per task: msg_liveness is
 // small (only nodes that ever stalled), so this is a plain in-memory lookup from here on.
 const livenessByNode=new Map(listLiveness(ctx).map(row=>[row.node,row]));
 const liveness:LivenessLookup=node=>livenessByNode.get(node)??null;
 return records.map((t,i)=>apiTask(ctx,{...t,repo:repos[i]},labels,counts,active.get(t.id)??0,liveness));
}
/** Preserve task.list's per-task label scope, sharing registry reads and label work. */
export function apiTaskPage(ctx: Ctx, records: TaskRecord[]): ApiTask[] {
 if (!records.length) return [];
 const registered = listRepos({...ctx,readOnly:true});
 const counts = unreadCounts(ctx,"human",records.map(t=>t.id));
 const labels = new Map<string, Map<string,string>>();
 const legacyRepos = new Map<string, ApiTask["repo"]>();
 return records.map(t => {
  let repo = t.repo ?? legacyRepos.get(t.brief.repo);
  if (!repo) {
   repo = registeredRepo(ctx,t.brief.repo) ?? {...repoFor(ctx,t.brief.repo),identityUnverified:true as const};
   legacyRepos.set(t.brief.repo,repo);
  }
  const key = JSON.stringify([repo.key,repo.path]);
  let names = labels.get(key);
  if (!names) { names = labelsFor([...registered,repo]); labels.set(key,names); }
  return apiTask(ctx,{...t,repo},names,counts);
 });
}
export function snapshotTasks(ctx: Ctx,records: TaskRecord[]): ApiTask[] {
 const rows=apiTasks(ctx,records.filter(t=>!t.archived));
 return rows.filter(t=>(!!t.activeAgentSessions||["queued","running"].includes(t.state))||(!t.dismissed && t.updatedAt>=ctx.now-86400)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);
}
export type AttentionTask = Pick<TaskData, "state" | "review" | "resolved" | "dismissed" | "retriedBy" | "reviewRequest" | "acceptanceState">;
export function taskAttentionReason(t: AttentionTask): "checks_failed" | "incomplete" | "review_requested" | null {
 if (!["done", "partial"].includes(t.state) || t.review || t.resolved || t.dismissed || t.retriedBy) return null;
 if (t.acceptanceState === "failed") return "checks_failed";
 if (t.state === "partial") return "incomplete";
 return t.reviewRequest ? "review_requested" : null;
}
export function needsReview(t: AttentionTask): boolean {
 return taskAttentionReason(t) === "review_requested";
}

/** Reverse retry links also cover snapshots published before retriedBy was persisted. */
export function supersededTaskIds(tasks: Pick<TaskData,"id"|"retryOf"|"retriedBy"|"state"|"dismissed">[]): Set<string> {
 const activeRetries = tasks.filter(t=>!t.dismissed&&t.state!=="stopped");
 const ids = new Set(activeRetries.map(t=>t.id));
 return new Set([
  ...tasks.filter(t=>t.retriedBy&&ids.has(t.retriedBy)).map(t=>t.id),
  ...activeRetries.flatMap(t=>t.retryOf?[t.retryOf]:[]),
 ]);
}
