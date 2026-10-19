import { fullTaskTitle } from "../../core/short-title";
import { repoFor, listRepos, labelsFor } from "../../core/repos";
import { taskData } from "../../link/pump";
import type { TaskData } from "../../link/envelope";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import type { ApiTask } from "./types";

export function apiTask(ctx: Ctx,t: TaskRecord, repoLabels?: Map<string,string>): ApiTask {
 const repo=t.repo??repoFor(ctx,t.brief.repo),labels=repoLabels??labelsFor([...listRepos({...ctx,readOnly:true}),repo]);
 return {...taskData(t),...(t.archived?{archived:true,archivePath:t.archivePath}:{}),fullTitle:fullTaskTitle(t),...(t.question?{question:t.question}:{}),rev:t.rev,queue:t.queue??null,...(t.source?{source:t.source}:{}),repo:{...repo,label:labels.get(repo.key)!},kind:t.kind??null,host:t.run?.host??null};
}
/** Batch labels once: apiTask alone reads task-backed repository labels. */
export function apiTasks(ctx: Ctx, records: TaskRecord[]): ApiTask[] {
 const repos=records.map(t=>t.repo??repoFor(ctx,t.brief.repo));
 const labels=labelsFor([...listRepos({...ctx,readOnly:true},repos),...repos]);
 return records.map((t,i)=>apiTask(ctx,{...t,repo:repos[i]},labels));
}
export function snapshotTasks(ctx: Ctx,records: TaskRecord[]): ApiTask[] {
 const rows=apiTasks(ctx,records.filter(t=>!t.archived));
 return rows.filter(t=>["queued","running"].includes(t.state)||(!t.dismissed && t.updatedAt>=ctx.now-86400)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);
}
export function needsReview(t: Pick<TaskData,"state"|"review"|"resolved"|"dismissed"|"retriedBy">): boolean {
 return ["done","partial"].includes(t.state)&&!t.review&&!t.resolved&&!t.dismissed&&!t.retriedBy;
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
