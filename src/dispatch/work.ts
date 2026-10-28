import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import { CoreError } from "../core/errors";
import { readTask, updateTask } from "../tasks/store";
import type { TaskRecord,AttemptUsage,AttemptTokens } from "../tasks/types";
import { attemptsWithTokens,itemsFromIndex,itemsOf,rollupTokens,type TokenItem } from "../tokens/rollup";
import { unknownTokens } from "../tokens/extract";
import type { Ctx } from "../types";
import { requirementsSchema, preferencesSchema } from "./types";
import { appendWorkEvent, boundedJson, dispatchDatabase } from "./store";
import { pidAlive } from "../link/store";

export const workOptionsSchema = z.object({
  requirements: requirementsSchema.default({}), preferences: preferencesSchema.default({models:[], strengths:[]}), model: z.string().min(1).max(256).optional(),
  kind: z.string().min(1).max(128).optional(), difficulty: z.enum(["simple","standard","complex"]).default("standard"),
  delegationEnforcement: z.enum(["strict","cooperative"]).default("strict"),
  allowDelegation: z.boolean().default(false), maxDepth: z.number().int().min(1).max(10).default(3),
  maxDescendants: z.number().int().min(1).max(1000).default(20), maxConcurrent: z.number().int().min(1).max(64).default(4),
  maxAttempts: z.number().int().min(1).max(20).default(3),
  priority: z.number().int().min(-100).max(100).default(0), expiresAt: z.number().positive().optional(),
  estimatePct: z.number().min(0).max(100).default(0),
}).strict();
export type WorkOptions = z.infer<typeof workOptionsSchema>;
export interface WorkNode {taskId:string; parentId:string|null; rootId:string; depth:number; options:WorkOptions; dependencies:string[]}
interface NodeRow {task_id:string;parent_id:string|null;root_id:string;depth:number;options:string;dependencies:string}
const node = (r: NodeRow): WorkNode => {
  const stored=JSON.parse(r.options) as Partial<WorkOptions>;
  return {taskId:r.task_id,parentId:r.parent_id,rootId:r.root_id,depth:r.depth,
    options:{...stored,delegationEnforcement:stored.delegationEnforcement??"cooperative"} as WorkOptions,
    dependencies:JSON.parse(r.dependencies)};
};
export function getWork(ctx:Ctx,id:string): WorkNode|null {
  const row=dispatchDatabase(ctx).query<NodeRow,[string]>("SELECT * FROM work_nodes WHERE task_id=?").get(id);return row?node(row):null;
}
export function workRestartEligibility(ctx:Ctx,task:TaskRecord,work:WorkNode):{allowed:boolean;reason?:string}{
 let reason:string|undefined;
 if(task.archived||!["failed","partial","limit","needs_input","stopped","done"].includes(task.state)||task.review?.accepted||task.state==="done"&&task.review?.accepted!==false)reason="Work is not eligible for another attempt";
 else if(task.state==="stopped"&&ctx.env.PACER_WORK_GRANT)reason="Only the owner may restart stopped work";
 else if(task.runnerPid&&pidAlive(task.runnerPid)||task.childPid&&pidAlive(task.childPid))reason="Previous executor is still active";
 else if(task.worktree&&!existsSync(task.worktree))reason="Task worktree is unavailable";
 else if(work.options.expiresAt!==undefined&&work.options.expiresAt<=ctx.now)reason="Work deadline has expired";
 else if(task.attempts.length>=(work.options.maxAttempts??3))reason="Managed work attempt limit reached";
 else if(pendingDependencies(ctx,task.id).length)reason="Required dependencies have not been reviewed";
 else for(let ancestor=work.parentId?getWork(ctx,work.parentId):null;ancestor;ancestor=ancestor.parentId?getWork(ctx,ancestor.parentId):null){if(readTask(ctx,ancestor.taskId)?.state==="stopped"){reason="A stopped ancestor cannot resume child work";break;}}
 return reason?{allowed:false,reason}:{allowed:true};
}
export function registerWork(ctx:Ctx,id:string,input:unknown={},parentId?:string,grant?:string):WorkNode {
  const db=dispatchDatabase(ctx);
  return db.transaction(()=>{
    const existing=getWork(ctx,id);if(existing)return existing;
    const task=readTask(ctx,id);if(!task)throw new CoreError("unknown_task","Unknown work task");
    if(grant&&authorizeWorkGrant(ctx,grant).taskId!==parentId)throw new CoreError("not_allowed","Grant does not authorize this parent");
    const options=workOptionsSchema.parse(input), parent=parentId?getWork(ctx,parentId):null;
    if(parentId&&!parent)throw new CoreError("not_allowed","Parent has no work policy");
    if(!parent&&options.delegationEnforcement!=="strict")throw new CoreError("not_allowed","New managed work requires strict delegation enforcement");
    const root=parent?getWork(ctx,parent.rootId)!:null;
    if(parent){
      if(parent.options.delegationEnforcement==="strict"&&options.delegationEnforcement!=="strict")throw new CoreError("not_allowed","Child cannot weaken strict delegation enforcement");
      if(!root!.options.allowDelegation||readTask(ctx,parentId!)?.state!=="running")throw new CoreError("not_allowed","Parent cannot delegate");
      if(task.brief.repo!==readTask(ctx,parentId!)!.brief.repo)throw new CoreError("not_allowed","Child repository must match its parent");
      if(parent.depth+1>parent.options.maxDepth)throw new CoreError("not_allowed","Delegation depth limit reached");
      const count=db.query<{n:number},[string]>("SELECT count(*) AS n FROM work_nodes WHERE root_id=?").get(parent.rootId)!.n;
      if(count-1>=root!.options.maxDescendants)throw new CoreError("not_allowed","Descendant limit reached");
      let ancestor:WorkNode|null=parent;
      while(ancestor){
        const subtreeCount=db.query<{n:number},[string]>("WITH RECURSIVE subtree(id) AS (SELECT task_id FROM work_nodes WHERE task_id=? UNION ALL SELECT child.task_id FROM work_nodes child JOIN subtree ON child.parent_id=subtree.id) SELECT count(*)-1 AS n FROM subtree").get(ancestor.taskId)!.n;
        if(subtreeCount>=ancestor.options.maxDescendants)throw new CoreError("not_allowed","Ancestor descendant limit reached");
        ancestor=ancestor.parentId?getWork(ctx,ancestor.parentId):null;
      }
      // Children inherit all hard requirements; callers cannot relax parent constraints.
      const inherited=parent.options.requirements;
      if(inherited.tools!==undefined&&options.requirements.tools!==undefined&&inherited.tools!==options.requirements.tools)throw new CoreError("not_allowed","Cannot relax inherited tools requirement");
      const tiers={small:0,medium:1,frontier:2};
      if(inherited.minTier&&options.requirements.minTier&&tiers[options.requirements.minTier]<tiers[inherited.minTier])throw new CoreError("not_allowed","Cannot lower inherited model tier");
      const minTier=options.requirements.minTier??inherited.minTier;
      options.requirements={...options.requirements,...inherited,minTier,context:Math.max(inherited.context??0,options.requirements.context??0)||undefined};
      const requested=input && typeof input==="object" ? input as Partial<WorkOptions> : {};
      options.allowDelegation=parent.options.allowDelegation && (requested.allowDelegation??parent.options.allowDelegation);
      options.maxDepth=Math.min(parent.options.maxDepth,requested.maxDepth??parent.options.maxDepth);
      options.maxDescendants=Math.min(parent.options.maxDescendants,requested.maxDescendants??parent.options.maxDescendants);
      options.maxConcurrent=Math.min(parent.options.maxConcurrent,requested.maxConcurrent??parent.options.maxConcurrent);
      options.maxAttempts=Math.min(parent.options.maxAttempts,requested.maxAttempts??parent.options.maxAttempts);
      options.expiresAt=Math.min(options.expiresAt??Infinity,parent.options.expiresAt??Infinity);if(!Number.isFinite(options.expiresAt))delete options.expiresAt;
    }
    const row:WorkNode={taskId:id,parentId:parentId??null,rootId:parent?.rootId??id,depth:parent?parent.depth+1:0,options,dependencies:[]};
    db.query("INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)").run(id,row.parentId,row.rootId,row.depth,boundedJson(options),"[]");
    if(task.state==="queued")setWorkWait(ctx,id,"queue",true);
    appendWorkEvent(ctx,id,"work.created",{parentId:row.parentId,depth:row.depth});return row;
  }).immediate();
}
const tokenHash=(token:string)=>createHash("sha256").update(token).digest("hex");
export function issueWorkGrant(ctx:Ctx,id:string,attempt:number):string {
  const work=getWork(ctx,id), task=readTask(ctx,id);
  if(!work?.options.allowDelegation||task?.state!=="running")throw new CoreError("not_allowed","Task cannot receive a delegation grant");
  const token=`pwg_${randomBytes(32).toString("hex")}`;
  dispatchDatabase(ctx).query("INSERT INTO work_grants(hash,task_id,attempt,expires) VALUES(?,?,?,?)").run(tokenHash(token),id,attempt,Math.min(ctx.now+task.timeoutS,work.options.expiresAt??Infinity));return token;
}
export function authorizeWorkGrant(ctx:Ctx,token:string):WorkNode {
  if(!/^pwg_[0-9a-f]{64}$/.test(token))throw new CoreError("not_allowed","Invalid work grant");
  const row=dispatchDatabase(ctx).query<{task_id:string;attempt:number;expires:number;revoked:number},[string]>("SELECT * FROM work_grants WHERE hash=?").get(tokenHash(token));
  const task=row?readTask(ctx,row.task_id):null;
  if(!row||row.revoked||row.expires<=ctx.now||task?.state!=="running"||row.attempt!==task.attempts.length+1)throw new CoreError("not_allowed","Expired or revoked work grant");
  return getWork(ctx,row.task_id)!;
}
export function revokeWorkGrants(ctx:Ctx,id:string):void {dispatchDatabase(ctx).query("UPDATE work_grants SET revoked=1 WHERE task_id=?").run(id);}
export function requireWorkScope(ctx:Ctx,token:string,id:string,review=false):WorkNode {
  const caller=authorizeWorkGrant(ctx,token), target=getWork(ctx,id);
  let cursor=target;const seen=new Set<string>();
  while(cursor&&!seen.has(cursor.taskId)){if(cursor.taskId===caller.taskId){if(review&&id===caller.taskId)break;return caller;}seen.add(cursor.taskId);cursor=cursor.parentId?getWork(ctx,cursor.parentId):null;}
  throw new CoreError("not_allowed","Operation is outside the delegated subtree");
}
export function workEvents(ctx:Ctx,id:string,after=0){const work=getWork(ctx,id);if(!work)throw new CoreError("unknown_task","Unknown work");return dispatchDatabase(ctx).query<{seq:number;task_id:string;at:number;kind:string;data:string},[string,number]>("SELECT seq,task_id,at,kind,data FROM work_events WHERE root_id=? AND seq>? ORDER BY seq LIMIT 500").all(work.rootId,after).map(e=>({...e,data:JSON.parse(e.data)}));}
type WaitKind="queue"|"dependency"|"child"|"capacity";
export function setWorkWait(ctx:Ctx,id:string,kind:WaitKind,waiting:boolean):void {
 const db=dispatchDatabase(ctx),row=db.query<{started_at:number|null;total_seconds:number;refs:number},[string,string]>("SELECT started_at,total_seconds,refs FROM work_waits WHERE task_id=? AND kind=?").get(id,kind);
 if(!row){db.query("INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?,?,?,?,?)").run(id,kind,waiting?ctx.now:null,0,waiting?1:0);return;}
 if(waiting&&row.started_at===null)db.query("UPDATE work_waits SET started_at=?,refs=1 WHERE task_id=? AND kind=?").run(ctx.now,id,kind);
 else if(!waiting&&row.started_at!==null)db.query("UPDATE work_waits SET total_seconds=total_seconds+?,started_at=NULL,refs=0 WHERE task_id=? AND kind=?").run(Math.max(0,ctx.now-row.started_at),id,kind);
}
export function syncDependencyWait(ctx:Ctx,id:string):void {const task=readTask(ctx,id);setWorkWait(ctx,id,"dependency",!!task&&task.state==="queued"&&pendingDependencies(ctx,id).length>0);}
export function beginChildWait(ctx:Ctx,id:string):void {
 const db=dispatchDatabase(ctx),row=db.query<{refs:number;started_at:number|null},[string]>("SELECT refs,started_at FROM work_waits WHERE task_id=? AND kind='child'").get(id);
 if(!row){setWorkWait(ctx,id,"child",true);return;}
 if(row.started_at===null)setWorkWait(ctx,id,"child",true);
 else db.query("UPDATE work_waits SET refs=refs+1 WHERE task_id=? AND kind='child'").run(id);
}
export function endChildWait(ctx:Ctx,id:string):void {
 const db=dispatchDatabase(ctx),row=db.query<{refs:number},[string]>("SELECT refs FROM work_waits WHERE task_id=? AND kind='child'").get(id);
 if(!row||row.refs<=0)return;
 if(row.refs>1)db.query("UPDATE work_waits SET refs=refs-1 WHERE task_id=? AND kind='child'").run(id);
 else setWorkWait(ctx,id,"child",false);
}
export function syncDependentWaits(ctx:Ctx,dependencyId:string):void {
 const work=getWork(ctx,dependencyId);if(!work)return;
 for(const row of dispatchDatabase(ctx).query<{task_id:string;dependencies:string},[string]>("SELECT task_id,dependencies FROM work_nodes WHERE root_id=?").all(work.rootId))
  if((JSON.parse(row.dependencies) as string[]).includes(dependencyId))syncDependencyWait(ctx,row.task_id);
}
export function workWaitTotals(ctx:Ctx,ids:string[]){
 const db=dispatchDatabase(ctx);let queue=0,dependency=0,child=0,capacity=0,provisional=0,unknownDependency=0,measuredCapacity=0;
 for(const id of ids){const rows=db.query<{kind:string;started_at:number|null;total_seconds:number},[string]>("SELECT kind,started_at,total_seconds FROM work_waits WHERE task_id=?").all(id);
 if(!rows.some(row=>row.kind==="dependency")&&db.query("SELECT 1 FROM work_events WHERE task_id=? AND kind='dependencies.changed' LIMIT 1").get(id))unknownDependency++;
 for(const row of rows){
  const seconds=row.total_seconds+(row.started_at===null?0:Math.max(0,ctx.now-row.started_at));
  if(row.kind==="queue")queue+=seconds;else if(row.kind==="dependency")dependency+=seconds;else if(row.kind==="child")child+=seconds;else if(row.kind==="capacity"){capacity+=seconds;measuredCapacity++;}
  if(row.started_at!==null)provisional++;
 }}
 return{queueWaitSeconds:queue,dependencyWaitSeconds:unknownDependency?null:dependency,childWaitSeconds:child,capacityWaitSeconds:measuredCapacity?capacity:null,unknownDependencyWaits:unknownDependency,provisionalWaits:provisional,waitAsOf:ctx.now};
}
export function listWork(ctx:Ctx,filter:{relation?:"roots"|"children"|"all";state?:string;repo?:string;before?:string;limit?:number}={}){
 const relation=filter.relation??"roots",limit=Math.min(100,Math.max(1,filter.limit??50));
 const rows=dispatchDatabase(ctx).query<NodeRow,[string,string,string,string,string,string,string,string,string,number]>(
  "SELECT n.* FROM work_nodes n JOIN tasks t ON t.id=n.task_id WHERE (?='all' OR (?='roots' AND n.parent_id IS NULL) OR (?='children' AND n.parent_id IS NOT NULL)) AND (?='' OR t.state=?) AND (?='' OR json_extract(t.record,'$.repo.key')=?) AND (?='' OR n.task_id<?) ORDER BY n.task_id DESC LIMIT ?"
 ).all(relation,relation,relation,filter.state??"",filter.state??"",filter.repo??"",filter.repo??"",filter.before??"",filter.before??"",limit+1);
 const page=rows.slice(0,limit);
 return{tasks:page.flatMap(r=>{const task=readTask(ctx,r.task_id);return task?[{id:task.id,parentId:r.parent_id,rootId:r.root_id,depth:r.depth,title:task.title??task.brief.goal,state:task.state,rev:task.rev,executor:task.executor??task.requestedExecutor,createdAt:task.createdAt,review:task.review??null}]:[];}),next:rows.length>limit?page.at(-1)?.task_id??null:null};
}
export function workTree(ctx:Ctx,id:string){
  const root=getWork(ctx,id);if(!root)throw new CoreError("unknown_task","Unknown work");
  const nodes=dispatchDatabase(ctx).query<NodeRow,[string]>("SELECT * FROM work_nodes WHERE root_id=? ORDER BY depth,task_id").all(root.rootId).map(r=>{
    const work=node(r),task=readTask(ctx,r.task_id);
    const decisions=dispatchDatabase(ctx).query<{attempt:number;data:string},[string]>("SELECT attempt,data FROM work_decisions WHERE task_id=? ORDER BY attempt").all(work.taskId).map(d=>{const p=JSON.parse(d.data);return{attempt:d.attempt,engine:p.engine,proposal:p.proposal,validation:p.validation,recommendedAction:p.recommendedAction,uncertainty:p.uncertainty,selectedCandidateId:p.selectedCandidateId,inputHash:p.inputHash,outputHash:p.outputHash,fallback:p.fallback,...(p.enforcement?{enforcement:p.enforcement}:{})};});
    const waivedChildren=dispatchDatabase(ctx).query<{dependency_id:string},[string]>("SELECT dependency_id FROM work_dependency_waivers WHERE task_id=?").all(work.taskId).map(row=>row.dependency_id);
    if(!task)return{...work,waivedChildren,title:"Archived work",state:"archived",rev:0,review:null,question:null,retryEligibility:{allowed:false,reason:"Archived work"},executor:null,model:null,actualModel:null,decisions,attempts:[],[TOKEN_ITEMS]:itemsFromIndex(ctx,work.taskId),createdAt:null,settledAt:null};
    const attempts=attemptsWithTokens(ctx,task.id,task.attempts).map(a=>({tokens:a.tokens,executor:a.executor,model:a.model??null,actualModel:a.actualModel??null,startedAt:a.startedAt,endedAt:a.endedAt,exitCode:a.exitCode,timedOut:a.timedOut,limitHit:a.limitHit,usageAtStart:a.usageAtStart??null,usageAtEnd:a.usageAtEnd??null}));
    return {...work,waivedChildren,title:task.title??task.brief.goal,state:task.state,rev:task.rev,review:task.review??null,question:task.question??null,retryEligibility:workRestartEligibility(ctx,task,work),executor:task.executor??task.requestedExecutor,model:task.result?.model??task.attempts.at(-1)?.model??null,actualModel:task.attempts.at(-1)?.actualModel??null,decisions,attempts,createdAt:task.createdAt,settledAt:task.settledAt??null};
  });
  return {rootId:root.rootId,nodes,totals:workTotals(nodes,workWaitTotals(ctx,nodes.map(n=>n.taskId)))};
}
/** Internal: index rows of a node whose record is gone. A symbol key survives spreading but never reaches JSON. */
const TOKEN_ITEMS=Symbol("tokenItems");
interface TotalsAttempt {startedAt:number;endedAt:number;executor?:string;model?:string|null;actualModel?:string|null;tokens?:AttemptTokens;usageAtStart?:AttemptUsage|null;usageAtEnd?:AttemptUsage|null}
interface TotalsNode {state:string;createdAt:number|null;attempts:TotalsAttempt[];[TOKEN_ITEMS]?:TokenItem[]}
export function observedUsageDelta(a?:AttemptUsage|null,b?:AttemptUsage|null):number|null {
 if(!a||!b||!a.poolId||a.poolId!==b.poolId||a.resetEpoch==null||a.resetEpoch!==b.resetEpoch||a.account!==b.account||a.window!==b.window
  ||a.stale!==false||b.stale!==false||!a.observationId||!b.observationId||a.observationId===b.observationId
  ||a.capturedAt==null||b.capturedAt==null||!Number.isFinite(a.capturedAt)||!Number.isFinite(b.capturedAt)||b.capturedAt<=a.capturedAt
  ||a.usedPct==null||b.usedPct==null||!Number.isFinite(a.usedPct)||!Number.isFinite(b.usedPct)||a.usedPct<0||b.usedPct>100||b.usedPct<a.usedPct)return null;
 return b.usedPct-a.usedPct;
}
function usagePools(attempts:TotalsAttempt[]){
 type Interval={start:number;end:number;startPct:number;endPct:number};
 type Group={account:string;poolId:string|null;resetEpoch:number|null;intervals:Interval[];unknownAttempts:number};
 const groups=new Map<string,Group>();
 for(const attempt of attempts){
  const a=attempt.usageAtStart,b=attempt.usageAtEnd,account=a?.account??b?.account??"unknown",poolId=a?.poolId&&a.poolId===b?.poolId?a.poolId:null,resetEpoch=a?.resetEpoch!==undefined&&a.resetEpoch===b?.resetEpoch?a.resetEpoch??null:null;
  const key=JSON.stringify([account,poolId,resetEpoch]),group=groups.get(key)??{account,poolId,resetEpoch,intervals:[],unknownAttempts:0};groups.set(key,group);
  if(observedUsageDelta(a,b)!==null)group.intervals.push({start:a!.capturedAt!,end:b!.capturedAt!,startPct:a!.usedPct!,endPct:b!.usedPct!});else group.unknownAttempts++;
 }
 return [...groups.values()].map(group=>{
  const intervals=group.intervals.sort((a,b)=>a.start-b.start),merged:Interval[]=[];
  const observations=intervals.flatMap(interval=>[{at:interval.start,pct:interval.startPct},{at:interval.end,pct:interval.endPct}]).sort((a,b)=>a.at-b.at||a.pct-b.pct);
  const inconsistentObservations=observations.some((observation,index)=>index>0&&(observation.pct<observations[index-1]!.pct||observation.at===observations[index-1]!.at&&observation.pct!==observations[index-1]!.pct));
  for(const interval of intervals){const last=merged.at(-1);if(last&&interval.start<=last.end){if(interval.end>last.end){last.end=interval.end;last.endPct=interval.endPct;}else if(interval.end===last.end)last.endPct=Math.max(last.endPct,interval.endPct);}
   else merged.push({...interval});}
  const inconsistent=inconsistentObservations||merged.some(interval=>interval.endPct<interval.startPct);
  return{account:group.account,poolId:group.poolId,resetEpoch:group.resetEpoch,observedDeltaPct:group.unknownAttempts||inconsistent?null:merged.reduce((sum,interval)=>sum+interval.endPct-interval.startPct,0),measuredIntervals:merged.length,unknownAttempts:group.unknownAttempts+(inconsistent?1:0),attribution:"shared-account-observation" as const};
 }).sort((a,b)=>JSON.stringify([a.account,a.poolId,a.resetEpoch]).localeCompare(JSON.stringify([b.account,b.poolId,b.resetEpoch])));
}
function tokenItemsOf(n:TotalsNode):TokenItem[]{
 if(n[TOKEN_ITEMS])return n[TOKEN_ITEMS];
 return itemsOf(n.attempts.map(a=>({executor:a.executor??"unknown",model:a.model,actualModel:a.actualModel,usageAtStart:a.usageAtStart,
  tokens:a.tokens??unknownTokens("rollup@1",{now:a.endedAt},"attempt has no token record")})));
}
export function workTotals(nodes:TotalsNode[],waits?:ReturnType<typeof workWaitTotals>){
 const attempts=nodes.flatMap(n=>n.attempts);
 const pools=usagePools(attempts);
 return {tasks:nodes.length,running:nodes.filter(n=>n.state==="running").length,queued:nodes.filter(n=>n.state==="queued").length,
  executionSeconds:attempts.reduce((sum,a)=>sum+Math.max(0,a.endedAt-a.startedAt),0),
  queueWaitSeconds:waits?.queueWaitSeconds??nodes.reduce((sum,n)=>sum+(n.createdAt!==null&&n.attempts.length?Math.max(0,n.attempts[0]!.startedAt-n.createdAt):0),0),
  dependencyWaitSeconds:waits?.dependencyWaitSeconds??null,childWaitSeconds:waits?.childWaitSeconds??null,capacityWaitSeconds:waits?.capacityWaitSeconds??null,provisionalWaits:waits?.provisionalWaits??0,waitAsOf:waits?.waitAsOf??null,
  tokens:rollupTokens(nodes.flatMap(tokenItemsOf)),
  usagePools:pools,usageMeasuredAttempts:attempts.length-pools.reduce((sum,p)=>sum+p.unknownAttempts,0),
  usageUnknownAttempts:pools.reduce((sum,p)=>sum+p.unknownAttempts,0)};
}
export function setWorkDependencies(ctx:Ctx,id:string,dependencies:string[],expectRev:number):void {
  const db=dispatchDatabase(ctx);db.transaction(()=>{
    const work=getWork(ctx,id),task=readTask(ctx,id);if(!work||!task)throw new CoreError("unknown_task","Unknown work");
    if(task.rev!==expectRev)throw new CoreError("conflict","Task changed");
    for(const dependency of dependencies){const dep=getWork(ctx,dependency);if(!dep||dep.rootId!==work.rootId||dependency===id)throw new CoreError("invalid_input","Invalid dependency");const visit=(current:string,seen=new Set<string>()):boolean=>{if(current===id)return true;if(seen.has(current))return false;seen.add(current);return getWork(ctx,current)?.dependencies.some(d=>visit(d,seen))??false;};if(visit(dependency))throw new CoreError("invalid_input","Dependency cycle");}
    db.query("UPDATE work_nodes SET dependencies=? WHERE task_id=?").run(boundedJson([...new Set(dependencies)]),id);
    db.query("DELETE FROM work_dependency_waivers WHERE task_id=?").run(id);
    updateTask(ctx,id,()=>{});appendWorkEvent(ctx,id,"dependencies.changed",{dependencies});
    syncDependencyWait(ctx,id);
  }).immediate();
}
export function waiveWorkDependency(ctx:Ctx,id:string,dependency:string,reason:string,expectRev:number):void {
  if(ctx.env.PACER_WORK_GRANT||ctx.env.PACER_ROLE==="executor")throw new CoreError("not_allowed","Only the work owner can waive a dependency");
  if(!reason.trim())throw new CoreError("invalid_input","A waiver reason is required");
  const db=dispatchDatabase(ctx);db.transaction(()=>{
    const work=getWork(ctx,id),task=readTask(ctx,id);
    if(!work||!task)throw new CoreError("unknown_task","Unknown work");
    if(task.rev!==expectRev)throw new CoreError("conflict","Task changed");
    if(!work.dependencies.includes(dependency)&&getWork(ctx,dependency)?.parentId!==id)throw new CoreError("invalid_input","Not a dependency or direct child of this work");
    db.query("INSERT OR REPLACE INTO work_dependency_waivers(task_id,dependency_id,reason,at) VALUES(?,?,?,?)").run(id,dependency,reason.trim().slice(0,2000),ctx.now);
    updateTask(ctx,id,()=>{});
    appendWorkEvent(ctx,id,"dependencies.waived",{dependency,reason:reason.trim().slice(0,2000)});
    syncDependencyWait(ctx,id);
  }).immediate();
}
export function pendingDependencies(ctx:Ctx,id:string):string[]{const work=getWork(ctx,id);if(!work)return[];const db=dispatchDatabase(ctx);return work.dependencies.filter(d=>readTask(ctx,d)?.review?.accepted!==true&&!db.query("SELECT 1 FROM work_dependency_waivers WHERE task_id=? AND dependency_id=?").get(id,d));}
export function pendingChildren(ctx:Ctx,id:string):TaskRecord[]{const db=dispatchDatabase(ctx);return db.query<{task_id:string},[string]>("SELECT task_id FROM work_nodes WHERE parent_id=?").all(id).flatMap(r=>{const t=readTask(ctx,r.task_id);return t&&!t.review?.accepted&&!db.query("SELECT 1 FROM work_dependency_waivers WHERE task_id=? AND dependency_id=?").get(id,r.task_id)?[t]:[];});}
