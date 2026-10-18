import { readHostCheck } from "../../remote/hosts";
import { readHostReachability } from "../../remote/eligibility";
import { listJobs } from "../../jobs/registry";
import { listRepos } from "../../core/repos";
import type { AttentionItem } from "../../attention/types";
import type { Ctx } from "../../types";
import type { ApiTask, Counts, ExecutorRow, HostSummary, SetupSummary, Today } from "./types";
import type { HostCfg } from "../../config/hosts";
import type { SetupChecklist } from "../../setup/checklist";
import { needsReview } from "./tasks";

export function buildCounts(tasks:ApiTask[],executors:ExecutorRow[],setup:SetupSummary,hosts:HostSummary[],attention:AttentionItem[]=[]):Counts {
 const byRepo:Counts["byRepo"]={};
 for(const t of tasks){const counts=byRepo[t.repo.key]??={review:0,running:0,attention:0};if(needsReview(t))counts.review++;if(t.state==="running")counts.running++;}
 for(const item of attention)if(item.repo){const counts=byRepo[item.repo.key]??={review:0,running:0,attention:0};counts.attention++;}
 return {attention:attention.length,problems:attention.filter(i=>i.severity!=="decide").length,review:tasks.filter(needsReview).length,running:tasks.filter(t=>t.state==="running").length,queued:tasks.filter(t=>t.state==="queued").length,ready:executors.filter(e=>e.rank!=="planner"&&["ready","busy"].includes(e.state)).length,executors:executors.filter(e=>e.rank!=="planner").length,setupOpen:setup.open,hostsWithProblems:hosts.filter(h=>["down","needs_setup"].includes(h.state)).length,byRepo};
}
export function buildToday(ctx:Ctx,tasks:ApiTask[]):Today {
 const d=new Date(ctx.now*1000);d.setHours(0,0,0,0);
 const since=d.getTime()/1000,rows=tasks.filter(t=>!["running","queued"].includes(t.state)&&t.updatedAt>=since);
 const byRepo:Today["byRepo"]={};for(const t of rows)byRepo[t.repo.key]=(byRepo[t.repo.key]??0)+1;
 return {since,done:rows.length,accepted:rows.filter(t=>t.review?.accepted===true).length,rejected:rows.filter(t=>t.review?.accepted===false).length,failed:rows.filter(t=>["failed","limit"].includes(t.state)).length,byRepo};
}
export function buildHosts(hosts:HostCfg[],executors:ExecutorRow[],tasks:ApiTask[],ctx?:Ctx):HostSummary[] {
 const jobs=ctx?listJobs(ctx):[],repos=ctx?listRepos({...ctx,readOnly:true},tasks.filter(t=>["queued","running"].includes(t.state)||(!t.dismissed&&t.updatedAt>=ctx.now-86400)).map(t=>t.repo)):[];
 return hosts.map(h=>({alias:h.alias,ssh:h.ssh.replace(/^[^@]+@/,""),state:h.paused?"paused":ctx&&(readHostReachability(ctx,h)?.failures??0)>=2?"down":jobs.some(j=>j.kind==="host.check"&&j.target===h.alias&&j.state==="running")?"checking":ctx&&(readHostCheck(ctx,h.alias)?.checks.some(c=>!c.ok)||repos.some(r=>!r.key.startsWith("local:")&&!h.repos[r.key]&&executors.some(e=>e.host===h.alias&&e.enabled)))?"needs_setup":"ready",running:tasks.filter(t=>t.state==="running"&&t.host===h.alias).length,maxTasks:h.maxTasks,executors:executors.filter(e=>e.host===h.alias).map(e=>e.id),repos:Object.keys(h.repos).length}));
}
export function buildSetup(checklist:SetupChecklist):SetupSummary {
 return {complete:checklist.complete,open:checklist.items.filter(i=>i.required&&i.status!=="done").length,items:checklist.items.map(({id,title,status,required})=>({id,title,status,required}))};
}
