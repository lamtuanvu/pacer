import { prepareCreationAdmission } from "../tasks/creation-admission";
import { beginWorkSync,finishUnlaunchedWorkSync,validatePendingWorkSync } from "../update/desktop/admission";
import { validateInput } from "../tasks/api";
import { requireProjectExecutor,requirePolicyIdentity } from "./project-policy";
import { readProjectStrategies } from "../config/project-strategies";
import { resolveRunner } from "../config/runner-id";
import { executorExclusion } from "../executors/availability";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import type { Ctx } from "../types";
import { CoreError } from "./errors";
import { delegate as delegateTask, stop as stopTask, review as reviewTask, wait as waitTask } from "./tasks";
import { launchTaskRunner, spawnRunner, type DelegateInput, type SpawnRunner } from "../tasks/api";
import { readTask, listTasksWhere, updateTask } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import { loadStrategy, MissingStrategyError, KINDS } from "../config/strategy";
import { slotBlock, slotUse } from "../engine/slots";
import { executorsFor } from "../engine/rank";
import { buildModelInventory } from "../dispatch/inventory";
import { meetsRequirements } from "../dispatch/candidates";
import { projectSnapshot, resolvePolicyRepoInput, } from "./project-policy";
import { requireRepoDirectory } from "./repos";
import {boundedGitRead} from "./git";
import { withLock, withLockSync } from "./lock";
import { getWork, registerWork, requireWorkScope, authorizeWorkGrant, workOptionsSchema, workTree, workTotals, workWaitTotals, workEvents, pendingChildren, pendingDependencies, syncDependentWaits, beginChildWait, endChildWait, type WorkOptions } from "../dispatch/work";
import { appendWorkEvent, dispatchDatabase, boundedJson } from "../dispatch/store";
import { recordWorkReview } from "../dispatch/learning";
import { pidAlive } from "../link/store";

export interface WorkInput {goal:string;repo?:string;kind?:string;title?:string;acceptance?:string;context?:string;constraints?:string;executor?:string;options?:Partial<WorkOptions>;requestId?:string}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function submitWork(ctx:Ctx,input:WorkInput,spawn:SpawnRunner=spawnRunner){
 if(ctx.env.PACER_WORK_GRANT)return delegateChild(ctx,input,spawn);
 if(ctx.env.PACER_ROLE==="executor")throw new CoreError("not_allowed","A scoped work grant is required");
 if(!input.repo)throw new CoreError("invalid_input","Repository is required");
 const repo=await resolvePolicyRepoInput(ctx,input.repo);await requireRepoDirectory(repo.path);
 const options=workOptionsSchema.parse({...input.options,kind:input.kind??input.options?.kind});
 const task=delegateTask(ctx,{brief:{goal:input.goal,repo:repo.path,acceptance:input.acceptance,context:input.context,constraints:input.constraints},title:input.title,
  repoRef:repo,repoValidated:true,kind:(KINDS as readonly string[]).includes(input.kind??"")?input.kind:null,executor:input.executor,requestId:input.requestId,source:"planner",dispatch:options},spawn);
 return task;
}
export async function delegateChild(ctx:Ctx,input:WorkInput,spawn:SpawnRunner=spawnRunner){
 const startedAt=performance.now();ctx={...ctx,env:{...ctx.env}};input=structuredClone(input);
 const fresh=()=>({...ctx,now:ctx.now+(performance.now()-startedAt)/1000});
 const token=ctx.env.PACER_WORK_GRANT;if(!token)throw new CoreError("not_allowed","A scoped work grant is required");
 const caller=authorizeWorkGrant(fresh(),token),parent=readTask(ctx,caller.taskId)!;
 if(input.repo&&input.repo!==parent.brief.repo)throw new CoreError("not_allowed","Child work must use its parent's repository");
 if(!input.requestId)throw new CoreError("invalid_input","Child delegation requires an idempotency requestId");
 const options=workOptionsSchema.parse({...caller.options,...input.options,kind:input.kind??input.options?.kind,requirements:input.options?.requirements??caller.options.requirements,preferences:input.options?.preferences??caller.options.preferences});
 if(!caller.options.allowDelegation)throw new CoreError("not_allowed","This work cannot delegate children");
 loadStrategy(fresh());
 const scope=caller.taskId,key=hash(input.requestId),fingerprint=hash(input);
 const db=dispatchDatabase(ctx);db.exec("CREATE TABLE IF NOT EXISTS work_requests(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(scope,key))");
 const existing=db.query<{fingerprint:string;task_id:string},[string,string]>("SELECT * FROM work_requests WHERE scope=? AND key=?").get(scope,key);
 if(existing){if(existing.fingerprint!==fingerprint)throw new CoreError("conflict","Idempotency key was used for different child work");return readTask(ctx,existing.task_id)!;}
 const parentCheckout=parent.run?.workdir??parent.worktree??parent.result?.worktree??parent.brief.repo;
 const head=await boundedGitRead(ctx.run,["git","-C",parentCheckout,"rev-parse","--verify","HEAD"],10_000);
 const parentBase=head.stdout.trim();
 if(head.code!==0||!/^[0-9a-f]{40,64}$/.test(parentBase))throw new CoreError("not_allowed","Cannot resolve the parent worktree commit for isolated child work");
 const validateProgress=(candidate:Readonly<DelegateInput>)=>{
  const currentCtx=fresh(),currentCaller=authorizeWorkGrant(currentCtx,token),currentParent=readTask(currentCtx,currentCaller.taskId);
  if(!currentParent||currentParent.rev!==parent.rev||JSON.stringify(currentCaller)!==JSON.stringify(caller))throw new CoreError("conflict","Parent work changed during child admission");
  const root=getWork(currentCtx,currentCaller.rootId),options=candidate.dispatch!;
  if(!root?.options.allowDelegation||!currentCaller.options.allowDelegation)throw new CoreError("not_allowed","Parent cannot delegate");
  const running=listTasksWhere(currentCtx,{states:["running"]});
  if(running.filter(task=>getWork(currentCtx,task.id)?.rootId===currentCaller.rootId).length>=root.options.maxConcurrent)throw new CoreError("not_allowed","Child cannot make progress: root concurrency is occupied; this executor cannot suspend");
  let ancestor=currentCaller;
  for(;;){
   const count=db.query<{n:number},[string]>("WITH RECURSIVE subtree(id) AS (SELECT task_id FROM work_nodes WHERE task_id=? UNION ALL SELECT child.task_id FROM work_nodes child JOIN subtree ON child.parent_id=subtree.id) SELECT count(*) AS n FROM subtree JOIN tasks t ON t.id=subtree.id WHERE t.state='running'").get(ancestor.taskId)!.n;
   if(count>=ancestor.options.maxConcurrent)throw new CoreError("not_allowed","Child cannot make progress: ancestor concurrency is occupied; this executor cannot suspend");
   if(!ancestor.parentId)break;const next=getWork(currentCtx,ancestor.parentId);if(!next)throw new CoreError("conflict","Ancestor work changed");ancestor=next;
  }
  let strategy;try{strategy=loadStrategy(currentCtx);}catch(error){if(error instanceof MissingStrategyError)throw new CoreError("conflict","Strategy changed during child admission");throw error;}
  const selection=projectSnapshot(currentCtx,strategy,currentParent.repo?.key??"").selection;
  const route=new Set(selection?.executors??executorsFor(options.kind??candidate.kind??null,strategy)),models=buildModelInventory(strategy,[],currentCtx.now);
  const permitted=Object.values(strategy.runners).filter(runner=>runner.enabled!==false&&route.has(runner.id)&&(!candidate.executor||runner.id===(resolveRunner(strategy,candidate.executor)?.id??candidate.executor))
   &&!executorExclusion(currentCtx,strategy,runner.id)&&(options.allowDelegation||runner.agent!==strategy.planner.agent||runner.account!==strategy.planner.account)
   &&models.some(model=>model.runner===runner.id&&meetsRequirements(model,options.requirements)&&(!options.model||model.binding.kind==="exact"&&model.binding.id===options.model)));
  if(!permitted.some(runner=>!slotBlock(strategy,runner.id,slotUse(running))))throw new CoreError("not_allowed","Child cannot make progress with the available executor slots and model policy; increase capacity or use another executor");
 };
 validateProgress({brief:{goal:input.goal,repo:parent.brief.repo},dispatch:options,executor:input.executor,kind:null});
 return withLock(ctx,`work-request-${hash([scope,key])}`,async()=>{
  authorizeWorkGrant(fresh(),token);
  const prior=db.query<{fingerprint:string;task_id:string},[string,string]>("SELECT * FROM work_requests WHERE scope=? AND key=?").get(scope,key);
  if(prior){if(prior.fingerprint!==fingerprint)throw new CoreError("conflict","Idempotency key was used for different child work");return readTask(ctx,prior.task_id)!;}
  const request:DelegateInput={brief:{goal:input.goal,repo:parent.brief.repo,acceptance:input.acceptance,context:input.context,constraints:input.constraints,base:parentBase,worktreeBase:"head"},title:input.title,
   repoRef:parent.repo,repoValidated:true,kind:(KINDS as readonly string[]).includes(input.kind??"")?input.kind:null,executor:input.executor,source:"planner",dispatch:options,workParent:caller.taskId,
   workGrant:token,workRequest:{scope,key,fingerprint},worktree:"new",worktree_reason:"Isolated delegated child work",
   admissionTaskLock:caller.taskId,admissionPaths:[parentCheckout],admissionValidate:validateProgress,
   admissionPrepare:async()=>{const current=await boundedGitRead(ctx.run,["git","-C",parentCheckout,"rev-parse","--verify","HEAD"],10000);if(current.code!==0||current.stdout.trim()!==parentBase)throw new CoreError("conflict","Parent HEAD changed during child admission");}};
  const current=fresh();return delegateTask({...current,env:{...current.env,PACER_ROLE:undefined,PACER_WORK_GRANT:undefined}},request,spawn,loadStrategy(current));
 });
}
export function scopedWorkTree(ctx:Ctx,id:string){
 const tree=workTree(ctx,id);if(ctx.env.PACER_WORK_GRANT)requireWorkScope(ctx,ctx.env.PACER_WORK_GRANT,id);
 const visible=new Set<string>([id]);for(const n of tree.nodes)if(n.parentId&&visible.has(n.parentId))visible.add(n.taskId);
 const granted=!!ctx.env.PACER_WORK_GRANT;
 const nodes=tree.nodes.filter(n=>visible.has(n.taskId)).map(n=>granted?{...n,rootId:id,parentId:n.taskId===id?null:n.parentId,dependencies:n.dependencies.filter(dep=>visible.has(dep))}:n);
 return {...tree,rootId:granted?id:tree.rootId,nodes,totals:workTotals(nodes,workWaitTotals(ctx,nodes.map(n=>n.taskId)))};
}
export function scopedWorkEvents(ctx:Ctx,id:string,after:number){const tree=scopedWorkTree(ctx,id),visible=new Set(tree.nodes.map(n=>n.taskId)),events=workEvents(ctx,id,after);return{events:events.filter(e=>visible.has(e.task_id)),next:events.at(-1)?.seq??after,hasMore:events.length===500};}
export async function reviewWork(ctx:Ctx,id:string,accepted:boolean,note?:string,expectRev?:number){
 const startedAt=performance.now(),fresh=()=>({...ctx,now:ctx.now+(performance.now()-startedAt)/1000});
 const work=getWork(ctx,id);if(!work)throw new CoreError("unknown_task","Unknown work");
 return withLock(ctx,`work-review-${work.rootId}`,async()=>{
  if(ctx.env.PACER_WORK_GRANT)requireWorkScope(fresh(),ctx.env.PACER_WORK_GRANT,id,true);
  const task=readTask(ctx,id);if(!task)throw new CoreError("unknown_task","Unknown work");
  if(expectRev===undefined||task.rev!==expectRev)throw new CoreError("conflict","Work revision changed; reload before reviewing");
  if(task.review)throw new CoreError("conflict","Work was already reviewed");
  if(accepted&&pendingChildren(ctx,id).length)throw new CoreError("conflict","Required children must be reviewed first");
  const current=fresh();
  const result=await reviewTask({...current,env:{...current.env,PACER_ROLE:undefined}},id,{verdict:accepted?"accept":"reject",note,expectRev});
  recordWorkReview(ctx,id,ctx.env.PACER_WORK_GRANT?"requesting-agent":"human");
  appendWorkEvent(ctx,id,"work.reviewed",{accepted,provenance:ctx.env.PACER_WORK_GRANT?"requesting-agent":"human",note:note?.slice(0,2000)??null});
  syncDependentWaits(ctx,id);
  return result;
 });
}
type RetryWorkInput={expectRev:number;requestId:string;feedback?:string;executor?:string};
type AnswerWorkInput={expectRev:number;requestId:string;text:string};
async function restartWork(ctx:Ctx,id:string,input:RetryWorkInput|AnswerWorkInput,kind:"retry"|"answer",spawn:SpawnRunner):Promise<NonNullable<ReturnType<typeof readTask>>>{
 const startedAt=performance.now();
 if(ctx.env.PACER_WORK_GRANT)requireWorkScope(ctx,ctx.env.PACER_WORK_GRANT,id,true);
 else if(ctx.env.PACER_ROLE==="executor")throw new CoreError("not_allowed","A scoped work grant is required");
 if(!/^[\w.-]{1,128}$/.test(input.requestId))throw new CoreError("invalid_input","A stable request ID of 1–128 letters, digits, dots, dashes or underscores is required");
 if(kind==="answer"&&(!(input as AnswerWorkInput).text||((input as AnswerWorkInput).text.length>2000)))throw new CoreError("invalid_input","Answer must contain 1–2000 characters");
 if(kind==="retry"&&((input as RetryWorkInput).feedback?.length??0)>2000)throw new CoreError("invalid_input","Feedback must contain at most 2000 characters");
 const key=createHash("sha256").update(`${kind}:${input.requestId}`).digest("hex");
 const fingerprint=createHash("sha256").update(JSON.stringify({kind,input})).digest("hex");
 const replayDb=dispatchDatabase(ctx);
 const replay=replayDb.query<{fingerprint:string},[string,string]>("SELECT fingerprint FROM work_retry_requests WHERE task_id=? AND key=?").get(id,key);
 if(replay){if(replay.fingerprint!==fingerprint)throw new CoreError("conflict","Request ID was used for different work");return readTask(ctx,id)!;}
 const lease=beginWorkSync(ctx,{kind:"operation",id,label:"Restarting managed work"});
 try{return await withLock(ctx,`work-retry-${id}`,async()=>{
  const db=dispatchDatabase(ctx);
  if(ctx.env.PACER_WORK_GRANT)requireWorkScope(ctx,ctx.env.PACER_WORK_GRANT,id,true);
  const prior=db.query<{fingerprint:string;attempt:number},[string,string]>("SELECT fingerprint,attempt FROM work_retry_requests WHERE task_id=? AND key=?").get(id,key);
  if(prior){if(prior.fingerprint!==fingerprint)throw new CoreError("conflict","Request ID was used for different work");return readTask(ctx,id)!;}
  const before=readTask(ctx,id),work=getWork(ctx,id);
  if(!before||!work)throw new CoreError("unknown_task","Unknown managed work");
  const fresh=()=>({...ctx,now:ctx.now+(performance.now()-startedAt)/1000});
  const checkRestart=(transactionCtx:Ctx)=>{
    if(ctx.env.PACER_WORK_GRANT)requireWorkScope(transactionCtx,ctx.env.PACER_WORK_GRANT,id,true);
    const task=readTask(ctx,id)!,current=getWork(ctx,id)!;
   if(task.rev!==input.expectRev)throw new CoreError("conflict","Work revision changed; reload before retrying");
   if(task.archived||!["failed","partial","limit","needs_input","stopped","done"].includes(task.state)||task.review?.accepted||task.state==="done"&&task.review?.accepted!==false)throw new CoreError("conflict","Work is not eligible for another attempt");
   if(task.state==="stopped"&&ctx.env.PACER_WORK_GRANT)throw new CoreError("not_allowed","Only the owner may restart stopped work");
   if(task.runnerPid&&pidAlive(task.runnerPid)||task.childPid&&pidAlive(task.childPid))throw new CoreError("conflict","Previous executor is still active");
   if(task.worktree&&!existsSync(task.worktree))throw new CoreError("conflict","Task worktree is unavailable; restore it before retrying");
   if(current.options.expiresAt!==undefined&&current.options.expiresAt<=transactionCtx.now)throw new CoreError("not_allowed","Work deadline has expired");
   if(task.attempts.length>=(current.options.maxAttempts??3))throw new CoreError("not_allowed","Managed work attempt limit reached");
   if(pendingDependencies(ctx,id).length)throw new CoreError("conflict","Required dependencies have not been reviewed");
   for(let ancestor=current.parentId?getWork(ctx,current.parentId):null;ancestor;ancestor=ancestor.parentId?getWork(ctx,ancestor.parentId):null){if(readTask(ctx,ancestor.taskId)?.state==="stopped")throw new CoreError("not_allowed","A stopped ancestor cannot resume child work");}
   if(kind==="answer"&&(task.state!=="needs_input"||!task.question||task.question.answer!==undefined))throw new CoreError("conflict","Work is not waiting for an answer");
   if(kind==="retry"&&(input as RetryWorkInput).executor)throw new CoreError("invalid_input","Executor overrides are not yet supported for managed retry");
    return {task,current};
  };
  checkRestart(fresh());
  if(before.worktree){
   if(!existsSync(before.worktree))throw new CoreError("conflict","Task worktree is unavailable; restore it before retrying");
   if(realpathSync(before.worktree)!==realpathSync(before.brief.repo)){
    const original=await boundedGitRead(ctx.run,["git","-C",before.brief.repo,"rev-parse","--path-format=absolute","--git-common-dir"],10000);
    const candidate=await boundedGitRead(ctx.run,["git","-C",before.worktree,"rev-parse","--path-format=absolute","--git-common-dir"],10000);
    if(original.code!==0||candidate.code!==0||!original.stdout.trim()||!candidate.stdout.trim()||realpathSync(original.stdout.trim())!==realpathSync(candidate.stdout.trim()))throw new CoreError("conflict","Task worktree no longer belongs to its repository");
   }
  }
  let answerBase:string|undefined;
  if(kind==="answer"){
   const worktree=before.worktree??before.result?.worktree;
   if(worktree){if(!existsSync(worktree))throw new CoreError("conflict","Worktree is unavailable for answering");
    const head=await boundedGitRead(ctx.run,["git","-C",worktree,"rev-parse","--verify","HEAD"],10000);
    if(head.code!==0||!/^[0-9a-f]{40}$/.test(head.stdout.trim()))throw new CoreError("invalid_input","Cannot read the asking executor's worktree HEAD");
    answerBase=head.stdout.trim();}
  }
  const strategy=()=>{try{return loadStrategy(fresh());}catch(error){if(error instanceof MissingStrategyError)return undefined;throw error;}};
  const initialStrategy=strategy();
  const policyKind=work.options.kind??before.kind??null;
  const requested=kind==="answer"?before.result?.executor??before.executor??before.attempts.at(-1)?.executor??before.requestedExecutor:before.requestedExecutor;
  const placement=before.placement?.requested??before.run?.mode??(before.worktree?"new":"auto");
  const checkout=before.worktree??before.result?.worktree;
  const validateConfigured=(candidate:{kind:string|null;requestedExecutor:string|null;placement:string},count:number)=>{
    checkRestart(fresh());validatePendingWorkSync(fresh(),lease);
    if(!count)return; // Missing strategy has the defined EMPTY_PLUGINS/no-policy semantics.
    const current=strategy();if(!current)throw new CoreError("conflict","Policy configuration changed");
    const problems=validateInput(current,{brief:before.brief,repoValidated:true,kind:candidate.kind===policyKind?null:candidate.kind,executor:candidate.requestedExecutor,dispatch:work.options});
    const runner=candidate.requestedExecutor?resolveRunner(current,candidate.requestedExecutor):null;
    if(runner?.enabled===false)problems.push("Executor is disabled");
    if(candidate.requestedExecutor&&executorExclusion(fresh(),current,candidate.requestedExecutor))problems.push("Executor is unavailable");
    if(problems.length)throw new CoreError("not_allowed",problems.join("; "));
    const projects=readProjectStrategies(fresh());
    if(!before.repo&&Object.values(projects.projects).some(project=>project.executors))throw new CoreError("invalid_input","Resolve the managed repository before applying project policies");
    if(before.repo){requirePolicyIdentity(fresh(),before.repo);requireProjectExecutor(projectSnapshot(fresh(),current,before.repo.key).selection,candidate.requestedExecutor);}
    if(candidate.requestedExecutor&&!buildModelInventory(current,[],fresh().now).some(model=>model.runner===candidate.requestedExecutor&&meetsRequirements(model,work.options.requirements)&&(!work.options.model||model.binding.kind==="exact"&&model.binding.id===work.options.model)))throw new CoreError("not_allowed","Executor does not satisfy managed model policy");
  };
  const admission=await prepareCreationAdmission(fresh(),{goal:before.brief.goal,repo:before.brief.repo,kind:policyKind,requestedExecutor:requested??null,placement},{
    taskLock:id,additionalDirectories:checkout?[checkout]:[],eligibleRunnerIds:initialStrategy?Object.keys(initialStrategy.runners):[],allowedPlacements:[placement],
    contextFingerprint:()=>JSON.stringify({task:readTask(ctx,id),work:getWork(ctx,id),root:getWork(ctx,work.rootId),strategy:strategy()??null,projects:readProjectStrategies(fresh())}),
    validateCurrent:validateConfigured,
    validateAmend:candidate=>{try{if(candidate.requestedExecutor!==(requested??null)||candidate.placement!==placement)return false;validateConfigured(candidate,1);return true;}catch{return false;}},
    validateArtifacts:async()=>{
      if(answerBase&&checkout){const head=await boundedGitRead(ctx.run,["git","-C",checkout,"rev-parse","--verify","HEAD"],10000);if(head.code!==0||head.stdout.trim()!==answerBase)throw new CoreError("conflict","Answer worktree HEAD changed during policy admission");}
      if(before.worktree&&realpathSync(before.worktree)!==realpathSync(before.brief.repo)){
        const original=await boundedGitRead(ctx.run,["git","-C",before.brief.repo,"rev-parse","--path-format=absolute","--git-common-dir"],10000);
        const candidate=await boundedGitRead(ctx.run,["git","-C",before.worktree,"rev-parse","--path-format=absolute","--git-common-dir"],10000);
        if(original.code!==0||candidate.code!==0||!original.stdout.trim()||!candidate.stdout.trim()||realpathSync(original.stdout.trim())!==realpathSync(candidate.stdout.trim()))throw new CoreError("conflict","Task worktree no longer belongs to its repository");
      }
    },
  });
  let created=false;
  const updated=await admission.consume(({input:authorized,revalidate})=>db.transaction(()=>{
   revalidate();
   const transactionCtx={...ctx,now:ctx.now+(performance.now()-startedAt)/1000};
   if(ctx.env.PACER_WORK_GRANT)requireWorkScope(transactionCtx,ctx.env.PACER_WORK_GRANT,id,true);
   const existing=db.query<{fingerprint:string},[string,string]>("SELECT fingerprint FROM work_retry_requests WHERE task_id=? AND key=?").get(id,key);
   if(existing){if(existing.fingerprint!==fingerprint)throw new CoreError("conflict","Request ID was used for different work");return readTask(ctx,id)!;}
   const {task,current}=checkRestart(transactionCtx);
   const changedKind=authorized.kind!==policyKind;
   if(changedKind)db.query("UPDATE work_nodes SET options=? WHERE task_id=?").run(boundedJson({...current.options,kind:authorized.kind??undefined}),id);
   const old={state:task.state,result:task.result?.status??null,review:task.review??null,attempts:task.attempts.length};
   db.query("UPDATE work_grants SET revoked=1 WHERE task_id=?").run(id);
   db.query("DELETE FROM work_reservations WHERE task_id=?").run(id);
   const next=updateTask(transactionCtx,id,t=>{
    if(changedKind)t.kind=authorized.kind;
    if(kind==="answer"){
     const text=(input as AnswerWorkInput).text;
     t.brief.qa=[...(t.brief.qa??[]),{q:t.question!.text,a:text}];
     if(answerBase)t.brief.base=answerBase;
     t.requestedExecutor=t.result?.executor??t.executor??t.attempts.at(-1)?.executor??t.requestedExecutor;
    }else if((input as RetryWorkInput).feedback?.trim())t.brief.feedback=[t.brief.feedback,(input as RetryWorkInput).feedback!.trim()].filter(Boolean).join("\n\n");
    t.worktree=t.worktree??t.result?.worktree;
    t.state="queued";t.queue={reason:"waiting_retry",detail:"Restart requested",since:transactionCtx.now,position:1,nextAt:transactionCtx.now};delete t.settledAt;delete t.result;delete t.review;delete t.resolved;delete t.resolutionCheckedAt;delete t.question;delete t.reviewRequest;
    delete t.run;delete t.runnerPid;delete t.childPid;delete t.pendingAttempt;delete t.attemptStartedAt;delete t.progress;delete t.executor;delete t.backend;
   });
   db.query("INSERT INTO work_retry_requests(task_id,key,fingerprint,attempt) VALUES(?,?,?,?)").run(id,key,fingerprint,task.attempts.length+1);
   created=true;
   appendWorkEvent(transactionCtx,id,kind==="answer"?"work.answer_recorded":"work.retry_requested",{attempt:task.attempts.length+1,previous:old,requestIdHash:key});
   return next;
  }).immediate());
  if(!created)return updated;
  try{launchTaskRunner({...ctx,env:{...ctx.env,PACER_WORK_GRANT:undefined,PACER_ROLE:undefined}},id,spawn);}catch(error){appendWorkEvent(ctx,id,"work.launch_deferred",{reason:error instanceof Error?error.message:"Launch failed"});}
  return updated;
 });}finally{finishUnlaunchedWorkSync(ctx,lease);}
}
export async function retryWork(ctx:Ctx,id:string,input:RetryWorkInput,spawn:SpawnRunner=spawnRunner){return restartWork(ctx,id,input,"retry",spawn);}
export async function answerWork(ctx:Ctx,id:string,input:AnswerWorkInput,spawn:SpawnRunner=spawnRunner){return restartWork(ctx,id,input,"answer",spawn);}
export function stopWork(ctx:Ctx,id:string,expectRev?:number){
 if(ctx.env.PACER_WORK_GRANT)requireWorkScope(ctx,ctx.env.PACER_WORK_GRANT,id);
 const task=readTask(ctx,id);if(!task)throw new CoreError("unknown_task","Unknown work");if(expectRev!==undefined&&task.rev!==expectRev)throw new CoreError("conflict","Task changed");
 const tree=scopedWorkTree(ctx,id);for(const n of tree.nodes)if(n.state!=="archived"&&!(TERMINAL_STATES as readonly string[]).includes(n.state))stopTask(ctx,n.taskId);
 return readTask(ctx,id)!;
}
export async function waitWork(ctx:Ctx,id:string,timeout=600){
 const parent=ctx.env.PACER_WORK_GRANT?requireWorkScope(ctx,ctx.env.PACER_WORK_GRANT,id).taskId:null;
 if(parent===id)throw new CoreError("not_allowed","A work item cannot wait for itself");
 if(parent)beginChildWait(ctx,parent);
 try{return await waitTask(ctx,id,timeout);}finally{if(parent)endChildWait({...ctx,now:Date.now()/1000},parent);}
}

/** Every transport, including in-process callers, must pass this gate. */
export function authorizeWorkOperation(ctx:Ctx,name:string,params:unknown):void{
 const token=ctx.env.PACER_WORK_GRANT;if(!token){if(ctx.env.PACER_ROLE==="executor"&&name.startsWith("dispatch."))throw new CoreError("not_allowed","A scoped work grant is required");return;}
 const caller=authorizeWorkGrant(ctx,token);
 const allowed=["dispatch.child","dispatch.tree","dispatch.events","dispatch.wait","dispatch.review","dispatch.retry","dispatch.answer","dispatch.stop","task.get","task.wait","task.log","task.diff"];
 if(!allowed.includes(name))throw new CoreError("not_allowed","Operation is not allowed by this work grant");
 if(name==="dispatch.child")return;
 const id=(params as {id?:unknown})?.id;if(typeof id!=="string")throw new CoreError("invalid_input","Task id is required");
 requireWorkScope(ctx,token,id,["dispatch.review","dispatch.retry","dispatch.answer"].includes(name));void caller;
}
