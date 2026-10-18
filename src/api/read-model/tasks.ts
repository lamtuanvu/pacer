import { repoFor, listRepos, labelsFor } from "../../core/repos";
import { taskData } from "../../link/pump";
import type { TaskData } from "../../link/envelope";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import type { ApiTask } from "./types";

export function apiTask(ctx: Ctx,t: TaskRecord): ApiTask {
 const repo=t.repo??repoFor(ctx,t.brief.repo),labels=labelsFor([...listRepos({...ctx,readOnly:true}),repo]);
 return {...taskData(t),...(t.question?{question:t.question}:{}),rev:t.rev,queue:t.queue??null,...(t.source?{source:t.source}:{}),repo:{...repo,label:labels.get(repo.key)!},kind:t.kind??null,host:t.run?.host??null};
}
export function snapshotTasks(ctx: Ctx,records: TaskRecord[]): ApiTask[] {
 const rows=records.map(t=>apiTask(ctx,t)),labels=labelsFor([...listRepos({...ctx,readOnly:true}),...rows.map(t=>t.repo)]);
 return rows.map(t=>({...t,repo:{...t.repo,label:labels.get(t.repo.key)!}})).filter(t=>["queued","running"].includes(t.state)||(!t.dismissed && t.updatedAt>=ctx.now-86400)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,200);
}
export function needsReview(t: Pick<TaskData,"state"|"review"|"resolved"|"dismissed"|"retriedBy">): boolean {
 return ["done","partial"].includes(t.state)&&!t.review&&!t.resolved&&!t.dismissed&&!t.retriedBy;
}
