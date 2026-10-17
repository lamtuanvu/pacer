import pkg from "../../../package.json";
import type { Ctx } from "../../types";
import type { Status } from "../../engine/status";
import type { Strategy } from "../../config/strategy";
import type { HostCfg } from "../../config/hosts";
import type { SetupChecklist } from "../../setup/checklist";
import { check } from "../../core/setup";
import { list as accountList } from "../../core/accounts";
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
 const promise=Promise.all([check({...ctx,readOnly:true}),accountList({...ctx,readOnly:true}).catch(()=>[])]).then(([setup,accounts])=>({setup,accounts:accounts.map(a=>({name:a.name,signedIn:a.signedIn}))}));
 cache.set(ctx.pacerHome,{at:ctx.now,promise});
 try{return await promise;}catch(e){cache.delete(ctx.pacerHome);throw e;}
}
export function buildReadModel(ctx:Ctx,input:{status:Status;strategy:Strategy;tasks:ApiTask[];setup:SetupChecklist;hosts:HostCfg[]}):ReadModelFields {
 const {status,strategy,tasks}=input,executors=buildExecutors(status,strategy,tasks,ctx.now),accounts=buildAccounts(status,strategy),planner=buildPlanner(status),hosts=buildHosts(input.hosts,executors,tasks),setup=buildSetup(input.setup);
 const repos=[...listRepos(ctx)],known=new Set(repos.map(r=>r.key));
 for(const t of tasks)if(!known.has(t.repo.key)){repos.push(t.repo);known.add(t.repo.key);}
 const labels=labelsFor(repos);
 return {service:{version:pkg.version,protocol:PROTOCOL_VERSION,pid:process.pid,startedAt},planner,executors,accounts,hosts,repos:repos.map(r=>({...r,label:labels.get(r.key)!})),setup,counts:buildCounts(tasks,executors,setup,hosts),today:buildToday(ctx,tasks)};
}
