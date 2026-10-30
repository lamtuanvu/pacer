import { arch, platform } from "node:os";
import { execFileSync } from "node:child_process";
import { desktopUpdateStatuses } from "../../update/desktop/service";
import { readProjectStrategies, type ProjectStrategyFile } from "../../config/project-strategies";
import { resolveProjectSelection } from "../../engine/project-routing";
import { validateExecution } from "../../config/execution";
import { resolveRunner } from "../../config/runner-id";
import { machineGuardState } from "../../engine/machine";
import { cachedPath, schedulePathRefresh, waitingIO } from "../../core/path-probe";
import { redactEndpointError } from "../../endpoints/state";
import { readPause } from "../../core/pause";
import { activeNotifier } from "../../clients/registry";
import { applyStore } from "../../attention/store";
import { deriveTaskItems } from "../../core/task-attention";
import { discoveryRuleInput } from "../../discovery/prompts";
import { executorsFor } from "../../engine/rank";
import type { ExecutorRow } from "./types";
import pkg from "../../../package.json";
import type { Ctx } from "../../types";
import type { Status } from "../../engine/status";
import type { Strategy } from "../../config/strategy";
import type { HostCfg } from "../../config/hosts";
import type { SetupChecklist } from "../../setup/checklist";
import { checkSetup as check, withStatus } from "../../setup/check";
import { listRepos, labelsFor } from "../../core/repos";
import { PROTOCOL_VERSION } from "../protocol";
import { buildExecutors, buildAccounts, buildPlanner } from "./capacity";
import { buildCounts, buildToday, buildHosts, buildSetup } from "./summary";
import type { ApiTask, ReadModelFields } from "./types";
export type * from "./types";
const machineOS = (() => {
 if (platform() !== "darwin") return platform();
 try { return `macOS ${execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 1000 }).trim()}`; }
 catch { return "macOS (version unavailable)"; }
})();
const startedAt=Math.floor(Date.now()/1000-process.uptime());
const cache=new Map<string,{at:number;promise:Promise<{setup:SetupChecklist;accounts:{name:string;signedIn:boolean|null}[]}>}>();
export async function readModelContext(ctx:Ctx) {
 const hit=cache.get(ctx.pacerHome);if(hit&&ctx.now>=hit.at&&ctx.now-hit.at<5)return hit.promise;
 // account.list spawns `orca account list`; the snapshot reads sign-in state from stored auth marks instead.
 const promise=check({...ctx,readOnly:true},{snapshotProbe:false,deferStatus:true}).then(setup=>({setup,accounts:[] as {name:string;signedIn:boolean|null}[]}));
 cache.set(ctx.pacerHome,{at:ctx.now,promise});
 try{return await promise;}catch(e){cache.delete(ctx.pacerHome);throw e;}
}
export function buildReadModel(ctx:Ctx,input:{status:Status;strategy:Strategy;tasks:ApiTask[];setup:SetupChecklist;hosts:HostCfg[];signedIn?:{name:string;signedIn:boolean|null}[]}):ReadModelFields {
 const {status,strategy,tasks}=input,executors=buildExecutors(status,strategy,tasks,ctx.now,ctx),accounts=buildAccounts(status,strategy,ctx).map(a=>({...a,signedIn:a.signedIn===false?false:input.signedIn?.find(row=>row.name===a.name)?.signedIn??a.signedIn})),planner=buildPlanner(status),hosts=buildHosts(input.hosts,executors,tasks,ctx),setup=buildSetup(withStatus(input.setup,status,ctx,tasks.some(t=>!!t.review)));
 let policies: ProjectStrategyFile | undefined, policyError: string | undefined;
 try { policies = readProjectStrategies(ctx); } catch (error) { policyError = error instanceof Error ? error.message : String(error); }
 const attentionTasks = tasks.map(task => ({ ...task, title: task.fullTitle ?? task.title }));
 const attention=applyStore(ctx,deriveTaskItems({now:ctx.now,tasks:attentionTasks,executors,accounts,planner,hosts,setup,update:null,retryTarget:t=>policyError ? null : retryTargetFor(t,strategy,executors,policies),discovery:discoveryRuleInput(ctx,ctx.now)}));
 const paused=readPause(ctx),secrets=Object.entries(ctx.env).filter(([key])=>/key|token|secret|password/i.test(key)).map(([,value])=>value??"").filter(Boolean);
 const safe=(text:string|null)=>text===null?null:redactEndpointError(text,secrets).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[redacted]");
 const pause=paused?{...paused,reason:safe(paused.reason),by:safe(paused.by)}:null;
 const recent=tasks.filter(t=>["queued","running"].includes(t.state)||(!t.dismissed&&t.updatedAt>=ctx.now-86400));
 const repos=[...listRepos(ctx,recent.map(t=>t.repo))],known=new Set(repos.map(r=>r.key));
 for(const t of recent)if(!known.has(t.repo.key)){repos.push(t.repo);known.add(t.repo.key);}
 const labels=labelsFor(repos);
 const notifier=activeNotifier(ctx);
 const exec = validateExecution(strategy.execution);
 const machine = {os: machineOS, arch: arch(), used: tasks.filter(t => t.state === "running" && !(t.host ?? (t.executor ? resolveRunner(strategy,t.executor)?.host : null))).length, ...machineCap(exec.localMaxTasks ?? null), ...machineGuardState(exec)};
 return {desktopUpdates:desktopUpdateStatuses(ctx),machine,pause,attention,service:{...(policyError ? {projectStrategyError: policyError} : {}),version:pkg.version,protocol:PROTOCOL_VERSION,pid:process.pid,startedAt,notifier:notifier?{client_id:notifier.client_id,kind:notifier.kind}:null,...waitingField()},planner,executors,accounts,hosts,repos:repos.map(r=>{schedulePathRefresh(r.path);return {...r,label:labels.get(r.key)!,...(cachedPath(r.path).unreachable?{unreachable:true as const}:{})};}),setup,counts:buildCounts(tasks,executors,setup,hosts,attention),today:buildToday(ctx,tasks)};
}

/** A repo-path call stuck for a second or more, e.g. behind a macOS removable-volume prompt. */
/** The machine row's cap fields. max stays numeric for 3.0 clients; without a cap it is MAX_SAFE_INTEGER. */
export function machineCap(hardCap:number|null){return {max:hardCap ?? Number.MAX_SAFE_INTEGER,hardCap,unlimited:hardCap===null};}
function waitingField(){const waiting=waitingIO();return waiting?{waiting}:{};}

export function retryTargetFor(task:ApiTask,strategy:Strategy,executors:ExecutorRow[],policies?:ProjectStrategyFile):string|null {
 if (task.repo.identityUnverified && policies && Object.values(policies.projects).some(p=>p.executors!==null)) return null;
 const selection=policies ? resolveProjectSelection(strategy,task.repo.key,policies.projects) : undefined;
 return (selection?.executors ?? executorsFor(task.kind,strategy)).find(id=>id!==task.executor && executors.some(e=>e.id===id && e.enabled && e.rank!=="planner" && e.state==="ready" && e.slots.used<e.slots.max))??null;
}
