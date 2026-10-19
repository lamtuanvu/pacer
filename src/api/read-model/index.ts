import { validateExecution } from "../../config/execution";
import { resolveRunner } from "../../config/runner-id";
import { readPluginReload } from "../../attention/plugin-reload";
import { cachedPath, schedulePathRefresh, waitingIO } from "../../core/path-probe";
import { redactEndpointError } from "../../endpoints/state";
import { readPause } from "../../core/pause";
import { activeNotifier } from "../../clients/registry";
import { applyStore } from "../../attention/store";
import { deriveTaskItems } from "../../core/task-attention";
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
 const promise=check({...ctx,readOnly:true},{snapshotProbe:false}).then(setup=>({setup,accounts:[] as {name:string;signedIn:boolean|null}[]}));
 cache.set(ctx.pacerHome,{at:ctx.now,promise});
 try{return await promise;}catch(e){cache.delete(ctx.pacerHome);throw e;}
}
export function buildReadModel(ctx:Ctx,input:{status:Status;strategy:Strategy;tasks:ApiTask[];setup:SetupChecklist;hosts:HostCfg[];signedIn?:{name:string;signedIn:boolean|null}[]}):ReadModelFields {
 const {status,strategy,tasks}=input,executors=buildExecutors(status,strategy,tasks,ctx.now,ctx),accounts=buildAccounts(status,strategy,ctx).map(a=>({...a,signedIn:a.signedIn===false?false:input.signedIn?.find(row=>row.name===a.name)?.signedIn??a.signedIn})),planner=buildPlanner(status),hosts=buildHosts(input.hosts,executors,tasks,ctx),setup=buildSetup(input.setup);
 const attention=applyStore(ctx,deriveTaskItems({pluginReload:readPluginReload(ctx),now:ctx.now,tasks,executors,accounts,planner,hosts,setup,update:null,retryTarget:t=>retryTargetFor(t,strategy,executors)}));
 const paused=readPause(ctx),secrets=Object.entries(ctx.env).filter(([key])=>/key|token|secret|password/i.test(key)).map(([,value])=>value??"").filter(Boolean);
 const safe=(text:string|null)=>text===null?null:redactEndpointError(text,secrets).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted]");
 const pause=paused?{...paused,reason:safe(paused.reason),by:safe(paused.by)}:null;
 const recent=tasks.filter(t=>["queued","running"].includes(t.state)||(!t.dismissed&&t.updatedAt>=ctx.now-86400));
 const repos=[...listRepos(ctx,recent.map(t=>t.repo))],known=new Set(repos.map(r=>r.key));
 for(const t of recent)if(!known.has(t.repo.key)){repos.push(t.repo);known.add(t.repo.key);}
 const labels=labelsFor(repos);
 const notifier=activeNotifier(ctx);
 const machine = {used: tasks.filter(t => t.state === "running" && !(t.host ?? (t.executor ? resolveRunner(strategy,t.executor)?.host : null))).length, max: validateExecution(strategy.execution).localMaxTasks ?? 2};
 return {machine,pause,attention,service:{version:pkg.version,protocol:PROTOCOL_VERSION,pid:process.pid,startedAt,notifier:notifier?{client_id:notifier.client_id,kind:notifier.kind}:null,...waitingField()},planner,executors,accounts,hosts,repos:repos.map(r=>{schedulePathRefresh(r.path);return {...r,label:labels.get(r.key)!,...(cachedPath(r.path).unreachable?{unreachable:true as const}:{})};}),setup,counts:buildCounts(tasks,executors,setup,hosts,attention),today:buildToday(ctx,tasks)};
}

/** A repo-path call stuck for a second or more, e.g. behind a macOS removable-volume prompt. */
function waitingField(){const waiting=waitingIO();return waiting?{waiting}:{};}

export function retryTargetFor(task:ApiTask,strategy:Strategy,executors:ExecutorRow[]):string|null {
 return executorsFor(task.kind,strategy).find(id=>id!==task.executor && executors.some(e=>e.id===id && e.enabled && e.rank!=="planner" && e.state==="ready" && e.slots.used<e.slots.max))??null;
}
