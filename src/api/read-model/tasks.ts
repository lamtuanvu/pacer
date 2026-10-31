import { fullTaskTitle } from "../../core/short-title";
import { repoFor, registeredRepo, listRepos, labelsFor } from "../../core/repos";
import { taskData } from "../../link/pump";
import type { TaskData } from "../../link/envelope";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import { unreadCounts } from "../../messaging/store";
import { getLiveness } from "../../messaging/liveness-store";
import { parentOf } from "../../messaging/participants";
import type { ApiTask } from "./types";

type UnreadCounts = ReturnType<typeof unreadCounts>;
export function apiTask(ctx: Ctx,t: TaskRecord, repoLabels?: Map<string,string>, counts?: UnreadCounts): ApiTask {
 const unread=(counts??unreadCounts(ctx,"human",[t.id])).get(t.id);
 const own=getLiveness(ctx,`task:${t.id}`), parent=parentOf(ctx,`task:${t.id}`), parentRow=parent?getLiveness(ctx,parent):null;
 const live=own?.reason?own:parentRow?.reason&&parentRow.escalatedAt?parentRow:null;
 const repo=t.repo??registeredRepo(ctx,t.brief.repo)??{...repoFor(ctx,t.brief.repo),identityUnverified:true as const},labels=repoLabels??labelsFor([...listRepos({...ctx,readOnly:true}),repo]);
 return {...taskData(t),...(t.archived?{archived:true,archivePath:t.archivePath}:{}),fullTitle:fullTaskTitle(t),...(t.question?{question:t.question}:{}),rev:t.rev,queue:t.queue??null,...(t.source?{source:t.source}:{}),repo:{...repo,label:labels.get(repo.key)!},kind:t.kind??null,host:t.run?.host??null,...(live?{liveness:{stalled:!!live.stalledAt,reason:live.reason,...(live.node!==`task:${t.id}`?{waitingOn:live.node}:{}),since:live.since}}:{}),...(unread?{messages:{unreadForHuman:unread.unread,...(unread.question?{question:{id:unread.question.id,text:unread.question.body.slice(0,1000),at:unread.question.createdAt}}:{})}}:{})};
}
/** Batch labels once: apiTask alone reads task-backed repository labels. */
export function apiTasks(ctx: Ctx, records: TaskRecord[]): ApiTask[] {
 const repos=records.map(t=>t.repo??registeredRepo(ctx,t.brief.repo)??{...repoFor(ctx,t.brief.repo),identityUnverified:true as const});
 const labels=labelsFor([...listRepos({...ctx,readOnly:true},repos),...repos]);
 const counts=unreadCounts(ctx,"human",records.map(t=>t.id));
 return records.map((t,i)=>apiTask(ctx,{...t,repo:repos[i]},labels,counts));
}
export function snapshotTasks(ctx: Ctx,records: TaskRecord[]): ApiTask[] {
 const rows=apiTasks(ctx,records.filter(t=>!t.archived));
 return rows.filter(t=>["queued","running"].includes(t.state)||(!t.dismissed && t.updatedAt>=ctx.now-86400)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);
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
