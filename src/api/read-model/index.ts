import { currentAttention } from "../../attention/store";
import { executorsFor } from "../../engine/rank";
import type { ExecutorRow } from "./types";
import pkg from "../../../package.json";
import type { Ctx } from "../../types";
import type { Status } from "../../engine/status";
import type { Strategy } from "../../config/strategy";
import type { HostCfg } from "../../config/hosts";
import type { SetupChecklist } from "../../setup/checklist";
import { check } from "../../core/setup";
import { listRepos, labelsFor } from "../../core/repos";
import { PROTOCOL_VERSION } from "../protocol";
import { buildExecutors, buildAccounts, buildPlanner } from "./capacity";
import { buildCounts, buildToday, buildHosts, buildSetup } from "./summary";
import type { ApiTask, ReadModelFields } from "./types";
export type * from "./types";
const startedAt=Math.floor(Date.now()/1000-process.uptime());
const cache=new Map<string,{at:number;promise:Promise<{setup:SetupChecklist;accounts:{name:string;signedIn:boolean|null}[]}>}>();
export async function readModelContext(ctx:Ctx) {
 const hit=cache.get(ctx.pacerHome);if(hit&&ctx.now>=hit.at&&ctx.now-hit.at<60)return hit.promise;
 // account.list spawns `orca account list`; the snapshot reads sign-in state from stored auth marks instead.
 const promise=check({...ctx,readOnly:true}).then(setup=>({setup,accounts:[] as {name:string;signedIn:boolean|null}[]}));
 cache.set(ctx.pacerHome,{at:ctx.now,promise});
 try{return await promise;}catch(e){cache.delete(ctx.pacerHome);throw e;}
}
export function buildReadModel(ctx:Ctx,input:{status:Status;strategy:Strategy;tasks:ApiTask[];setup:SetupChecklist;hosts:HostCfg[];signedIn?:{name:string;signedIn:boolean|null}[]}):ReadModelFields {
 const {status,strategy,tasks}=input,executors=buildExecutors(status,strategy,tasks,ctx.now),accounts=buildAccounts(status,strategy).map(a=>({...a,signedIn:input.signedIn?.find(row=>row.name===a.name)?.signedIn??null})),planner=buildPlanner(status),hosts=buildHosts(input.hosts,executors,tasks),setup=buildSetup(input.setup);
 const attention=currentAttention(ctx,{now:ctx.now,tasks,executors,accounts,planner,setup,update:null,retryTarget:t=>retryTargetFor(t,strategy,executors)});
 const repos=[...listRepos(ctx)],known=new Set(repos.map(r=>r.key));
 for(const t of tasks)if(!known.has(t.repo.key)){repos.push(t.repo);known.add(t.repo.key);}
 const labels=labelsFor(repos);
 return {attention,service:{version:pkg.version,protocol:PROTOCOL_VERSION,pid:process.pid,startedAt},planner,executors,accounts,hosts,repos:repos.map(r=>({...r,label:labels.get(r.key)!})),setup,counts:buildCounts(tasks,executors,setup,hosts,attention),today:buildToday(ctx,tasks)};
}

export function retryTargetFor(task:ApiTask,strategy:Strategy,executors:ExecutorRow[]):string|null {
 return executorsFor(task.kind,strategy).find(id=>id!==task.executor && executors.some(e=>e.id===id && e.enabled && e.rank!=="planner" && e.state==="ready" && e.slots.used<e.slots.max))??null;
}
