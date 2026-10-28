import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork, getWork, workOptionsSchema, workTree, workTotals, listWork, issueWorkGrant, authorizeWorkGrant, revokeWorkGrants, setWorkDependencies, waiveWorkDependency, pendingChildren, pendingDependencies, workEvents,beginChildWait,endChildWait } from "../src/dispatch/work";
import {scopedWorkEvents} from "../src/core/work";
import {appendWorkEvent,dispatchDatabase} from "../src/dispatch/store";
import {main} from "../src/cli";
import {retryWork,answerWork,reviewWork} from "../src/core/work";

function root() {const ctx=fakeCtx();const task=createTask(ctx,{brief:{goal:"root",repo:tmpDir()},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,task.id,{allowDelegation:true});return {ctx,task};}
test("new managed work is strict and a child cannot weaken enforcement",()=>{
 const {ctx,task}=root();
 expect(getWork(ctx,task.id)?.options.delegationEnforcement).toBe("strict");
 updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});
 expect(()=>registerWork(ctx,child.id,{delegationEnforcement:"cooperative"},task.id)).toThrow();
 expect(registerWork(ctx,child.id,{},task.id).options.delegationEnforcement).toBe("strict");
});
test("old managed records retain cooperative enforcement",()=>{
 const {ctx,task}=root(),db=dispatchDatabase(ctx);
 const legacy=workOptionsSchema.parse({allowDelegation:true}) as Record<string,unknown>;
 delete legacy.delegationEnforcement;
 db.query("UPDATE work_nodes SET options=? WHERE task_id=?").run(JSON.stringify(legacy),task.id);
 expect(getWork(ctx,task.id)?.options.delegationEnforcement).toBe("cooperative");
});
test("new roots cannot opt out of strict enforcement",()=>{
 const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"root",repo:tmpDir()},kind:"feature",requestedExecutor:null,timeoutS:600});
 expect(()=>registerWork(ctx,task.id,{delegationEnforcement:"cooperative"})).toThrow();
});
test("work grant is attempt-bound and never stored in plaintext",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const token=issueWorkGrant(ctx,task.id,1); expect(authorizeWorkGrant(ctx,token).taskId).toBe(task.id);
 expect(()=>authorizeWorkGrant(ctx,"pwg_forged")).toThrow();
 updateTask(ctx,task.id,t=>{t.state="stopped";});expect(()=>authorizeWorkGrant(ctx,token)).toThrow();
 expect(JSON.stringify(workTree(ctx,task.id))).not.toContain(token);
});
test("lineage rejects cycles and retains sequence-based history",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"research",requestedExecutor:null,timeoutS:600});registerWork(ctx,child.id,{},task.id);
 expect(workTree(ctx,task.id).nodes.map(n=>n.depth)).toEqual([0,1]);
 setWorkDependencies(ctx,task.id,[child.id],2);
 expect(()=>setWorkDependencies(ctx,child.id,[task.id],1)).toThrow();
 updateTask(ctx,child.id,t=>{t.state="done";});
 const events=workEvents(ctx,task.id,0);expect(events.length).toBeGreaterThan(1);expect(workEvents(ctx,task.id,events.at(-1)!.seq)).toEqual([]);
});
test("child requirements may strengthen but never weaken inherited tier",()=>{
 const {ctx,task}=root();const dbRoot=registerWork(ctx,task.id);void dbRoot;updateTask(ctx,task.id,t=>{t.state="running";});
 const strict=createTask(ctx,{brief:{goal:"strict",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});
 const stronger=registerWork(ctx,strict.id,{requirements:{minTier:"frontier"}},task.id);expect(stronger.options.requirements.minTier).toBe("frontier");
});
test("child delegation limits only narrow and rejected dependency needs audited waiver",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});
 const policy=registerWork(ctx,child.id,{allowDelegation:false,maxDepth:1,maxDescendants:1,maxConcurrent:1},task.id);
 expect(policy.options.allowDelegation).toBe(false);expect(policy.options.maxDepth).toBe(1);
 const dep=createTask(ctx,{brief:{goal:"dep",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});
 registerWork(ctx,dep.id,{},task.id);
 setWorkDependencies(ctx,child.id,[dep.id],1);
 expect(pendingDependencies(ctx,child.id)).toEqual([dep.id]);
 expect(()=>waiveWorkDependency(ctx,child.id,dep.id,"",2)).toThrow();
 waiveWorkDependency(ctx,child.id,dep.id,"Rejected outcome accepted by owner",2);
 expect(pendingDependencies(ctx,child.id)).toEqual([]);
 expect(workEvents(ctx,task.id).some(e=>e.kind==="dependencies.waived")).toBe(true);
});
test("scoped event cursor advances over unrelated root events",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,child.id,{},task.id);
 for(let i=0;i<510;i++)appendWorkEvent(ctx,task.id,"root.note",{i});
 appendWorkEvent(ctx,child.id,"child.note",{});
 const first=scopedWorkEvents(ctx,child.id,0);
 expect(first.hasMore).toBe(true);
 const second=scopedWorkEvents(ctx,child.id,first.next);
 expect(second.events.some(e=>e.kind==="child.note")).toBe(true);
});
test("work list filters roots, children, and state with a stable page cursor",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,child.id,{},task.id);
 expect(listWork(ctx,{relation:"roots"}).tasks.map(t=>t.id)).toEqual([task.id]);
 expect(listWork(ctx,{relation:"children",state:"queued"}).tasks.map(t=>t.id)).toEqual([child.id]);
 expect(listWork(ctx,{relation:"all",limit:1}).next).toBeTruthy();
});
test("work list rows carry the branch and an honest token roll-up",()=>{
 const {ctx,task}=root();
 const row=listWork(ctx,{relation:"all"}).tasks.find(t=>t.id===task.id)!;
 expect(row).toHaveProperty("branch");
 // A task with no usage reading reports null, never a zero total.
 expect(row.tokens).toBeNull();
});
test("owner can waive a required child with an audited reason",()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,child.id,{},task.id);
 expect(pendingChildren(ctx,task.id).map(t=>t.id)).toEqual([child.id]);
 waiveWorkDependency(ctx,task.id,child.id,"Child result superseded",readTask(ctx,task.id)!.rev);
 expect(pendingChildren(ctx,task.id)).toEqual([]);
});
test("work list repository scope excludes another repository before paging",()=>{
 const ctx=fakeCtx(),pathA=tmpDir(),pathB=tmpDir();
 const a=createTask(ctx,{brief:{goal:"A",repo:pathA},kind:"debug",requestedExecutor:null,timeoutS:60,repo:{key:"repoA",path:pathA,label:"A"}});
 const b=createTask(ctx,{brief:{goal:"B",repo:pathB},kind:"debug",requestedExecutor:null,timeoutS:60,repo:{key:"repoB",path:pathB,label:"B"}});
 registerWork(ctx,a.id);registerWork(ctx,b.id);
 expect(listWork(ctx,{repo:"repoA",limit:1}).tasks.map(t=>t.id)).toEqual([a.id]);
 expect(listWork(ctx,{repo:"repoB",limit:1}).tasks.map(t=>t.id)).toEqual([b.id]);
});
test("CLI work review honors an explicit stale revision",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="done";});
 const rev=readTask(ctx,task.id)!.rev;
 const stale=await main(["dispatch","review","--id",task.id,"--accept","--expect-rev",String(rev-1)],ctx);
 expect(stale.code).toBe(2);expect(readTask(ctx,task.id)?.review).toBeUndefined();
 const current=await main(["dispatch","review","--id",task.id,"--accept","--expect-rev",String(rev)],ctx);
 expect(current.code).toBe(0);expect(readTask(ctx,task.id)?.review?.accepted).toBe(true);
});
test("managed retry keeps the task and work lineage and is idempotent",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="failed";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 const before=readTask(ctx,task.id)!,spawns:string[]=[];
 const spawn=(_ctx:typeof ctx,id:string)=>{spawns.push(id);return 1;};
 const first=await retryWork(ctx,task.id,{expectRev:before.rev,requestId:"retry-1"},spawn);
 expect(first.id).toBe(task.id);expect(first.state).toBe("queued");expect(first.attempts).toHaveLength(1);
 expect(workTree(ctx,task.id).nodes).toHaveLength(1);expect(spawns).toEqual([task.id]);
 const replay=await retryWork(ctx,task.id,{expectRev:before.rev,requestId:"retry-1"},spawn);
 expect(replay.id).toBe(task.id);expect(spawns).toEqual([task.id]);
 await expect(retryWork(ctx,task.id,{expectRev:before.rev,requestId:"retry-2"},spawn)).rejects.toThrow();
});
test("failed retry launch keeps a durable queue intent",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="failed";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 const result=await retryWork(ctx,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"launch-failure"},()=>{throw new Error("launch unavailable");});
 expect(result.queue?.reason).toBe("waiting_retry");expect(readTask(ctx,task.id)?.queue?.reason).toBe("waiting_retry");
 expect(workEvents(ctx,task.id).some(event=>event.kind==="work.launch_deferred")).toBe(true);
});
test("retry rejects a checkout from a different Git repository",async()=>{
 const ctx=fakeCtx({run:realRun}),repo=gitRepo(),foreign=gitRepo();
 const task=createTask(ctx,{brief:{goal:"root",repo},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,task.id);
 updateTask(ctx,task.id,t=>{t.state="failed";t.worktree=foreign;});
 await expect(retryWork(ctx,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"foreign"},()=>1)).rejects.toThrow("no longer belongs");
});
test("answer rechecks a grant after reading the asking worktree",async()=>{
 const ctx=fakeCtx(),repo=gitRepo();
 const parent=createTask(ctx,{brief:{goal:"parent",repo},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,parent.id,{allowDelegation:true});updateTask(ctx,parent.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo},kind:"feature",requestedExecutor:null,timeoutS:600});registerWork(ctx,child.id,{},parent.id);
 updateTask(ctx,child.id,t=>{t.state="needs_input";t.worktree=repo;t.question={text:"Which?",at:ctx.now};});
 const token=issueWorkGrant(ctx,parent.id,1),scoped={...ctx,env:{...ctx.env,PACER_WORK_GRANT:token,PACER_ROLE:"executor"}};
 scoped.run=async()=>{revokeWorkGrants(ctx,parent.id);return{code:0,stdout:"a".repeat(40),stderr:""};};
 await expect(answerWork(scoped,child.id,{expectRev:readTask(ctx,child.id)!.rev,requestId:"revoked-during-read",text:"Blue"},()=>1)).rejects.toThrow("Expired or revoked");
 expect(readTask(ctx,child.id)?.brief.qa).toBeUndefined();
});
test("work tree explains expired and missing-worktree retry blocks",()=>{
 const {ctx,task}=root();const missing=tmpDir();rmSync(missing,{recursive:true,force:true});
 updateTask(ctx,task.id,t=>{t.state="failed";t.worktree=missing;});
 expect(workTree(ctx,task.id).nodes[0]?.retryEligibility).toEqual({allowed:false,reason:"Task worktree is unavailable"});
 updateTask(ctx,task.id,t=>{delete t.worktree;});
 const work=registerWork(ctx,task.id);work.options.expiresAt=ctx.now-1;
 dispatchDatabase(ctx).query("UPDATE work_nodes SET options=? WHERE task_id=?").run(JSON.stringify(work.options),task.id);
 expect(workTree(ctx,task.id).nodes[0]?.retryEligibility).toEqual({allowed:false,reason:"Work deadline has expired"});
});
test("managed answer records QA once and enforces the cumulative attempt limit",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="needs_input";t.question={text:"Which color?",at:ctx.now};t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:0,timedOut:false,limitHit:false,log:""});});
 const rev=readTask(ctx,task.id)!.rev,spawn=()=>1;
 const answered=await answerWork(ctx,task.id,{expectRev:rev,requestId:"answer-1",text:"Blue"},spawn);
 expect(answered.id).toBe(task.id);expect(answered.brief.qa).toEqual([{q:"Which color?",a:"Blue"}]);
 expect((await answerWork(ctx,task.id,{expectRev:rev,requestId:"answer-1",text:"Blue"},spawn)).brief.qa).toHaveLength(1);
 updateTask(ctx,task.id,t=>{t.state="failed";for(let i=0;i<2;i++)t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 await expect(retryWork(ctx,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"retry-over-limit"},spawn)).rejects.toThrow();
});
test("a planner grant may retry a child but never itself and is not passed to the new executor",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,child.id,{},task.id);
 updateTask(ctx,child.id,t=>{t.state="failed";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 const token=issueWorkGrant(ctx,task.id,1),scoped={...ctx,env:{...ctx.env,PACER_WORK_GRANT:token,PACER_ROLE:"executor"}};
 const seen:string[]=[];
 const spawn=(c:typeof ctx,id:string)=>{seen.push(`${id}:${c.env.PACER_WORK_GRANT??"none"}`);return 1;};
 await expect(retryWork(scoped,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"self"},spawn)).rejects.toThrow();
 const result=await retryWork(scoped,child.id,{expectRev:readTask(ctx,child.id)!.rev,requestId:"child"},spawn);
 expect(result.id).toBe(child.id);expect(seen).toEqual([`${child.id}:none`]);
});
test("a stopped child can only be restarted by its owner",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="running";});
 const child=createTask(ctx,{brief:{goal:"child",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,child.id,{},task.id);
 updateTask(ctx,child.id,t=>{t.state="stopped";});
 const token=issueWorkGrant(ctx,task.id,1),scoped={...ctx,env:{...ctx.env,PACER_WORK_GRANT:token,PACER_ROLE:"executor"}};
 await expect(retryWork(scoped,child.id,{expectRev:readTask(ctx,child.id)!.rev,requestId:"stopped-scoped"},()=>1)).rejects.toThrow("Only the owner");
 expect((await retryWork(ctx,child.id,{expectRev:readTask(ctx,child.id)!.rev,requestId:"stopped-owner"},()=>1)).state).toBe("queued");
});
test("CLI managed retry and answer keep explicit revision preconditions",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="failed";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 const rev=readTask(ctx,task.id)!.rev;
 const stale=await main(["dispatch","retry","--id",task.id,"--request-id","cli-retry","--expect-rev",String(rev-1)],ctx);
 expect(stale.code).toBe(2);expect(readTask(ctx,task.id)?.state).toBe("failed");
 const missing=await main(["dispatch","answer","--id",task.id,"--request-id","cli-answer","--expect-rev",String(rev),"--text","Blue"],ctx);
 expect(missing.code).toBe(2);expect(readTask(ctx,task.id)?.state).toBe("failed");
});
test("dependency wait is measured from blocking until independent review",async()=>{
 const {ctx,task}=root();ctx.now=100;updateTask(ctx,task.id,t=>{t.state="running";});
 const blocked=createTask(ctx,{brief:{goal:"blocked",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,blocked.id,{},task.id);
 const required=createTask(ctx,{brief:{goal:"required",repo:task.brief.repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,required.id,{},task.id);
 setWorkDependencies(ctx,blocked.id,[required.id],readTask(ctx,blocked.id)!.rev);
 ctx.now=110;updateTask(ctx,required.id,t=>{t.state="done";t.attempts.push({executor:"codex",model:null,startedAt:105,endedAt:109,exitCode:0,timedOut:false,limitHit:false,log:""});});
 await reviewWork(ctx,required.id,true,undefined,readTask(ctx,required.id)!.rev);
 expect(workTree(ctx,task.id).totals.dependencyWaitSeconds).toBe(10);
});
test("overlapping child waits count parent wall time only once",()=>{
 const {ctx,task}=root();ctx.now=100;beginChildWait(ctx,task.id);beginChildWait(ctx,task.id);
 ctx.now=110;endChildWait(ctx,task.id);ctx.now=120;endChildWait(ctx,task.id);
 expect(workTree(ctx,task.id).totals.childWaitSeconds).toBe(20);
});
test("overlapping account readings do not double-count child quota movement",()=>{
 const usage=(usedPct:number,capturedAt:number)=>({account:"team",window:"five-hour",poolId:"team:five-hour",resetEpoch:500,capturedAt,observationId:`obs-${capturedAt}`,stale:false,usedPct,at:capturedAt});
 const attempt=(start:number,end:number,startPct:number,endPct:number)=>({startedAt:start,endedAt:end,usageAtStart:usage(startPct,start),usageAtEnd:usage(endPct,end)});
 const totals=workTotals([{state:"done",createdAt:0,attempts:[attempt(10,30,10,30)]},{state:"done",createdAt:0,attempts:[attempt(15,25,15,25)]}]);
 expect(totals.usagePools).toEqual([{account:"team",poolId:"team:five-hour",resetEpoch:500,observedDeltaPct:20,measuredIntervals:1,unknownAttempts:0,attribution:"shared-account-observation"}]);
});
test("conflicting overlapping account readings are unknown",()=>{
 const reading=(usedPct:number,capturedAt:number)=>({account:"team",window:"five-hour",poolId:"team:five-hour",resetEpoch:500,capturedAt,observationId:`obs-${capturedAt}`,stale:false,usedPct,at:capturedAt});
 const attempt=(start:number,end:number,startPct:number,endPct:number)=>({startedAt:start,endedAt:end,usageAtStart:reading(startPct,start),usageAtEnd:reading(endPct,end)});
 const totals=workTotals([{state:"done",createdAt:0,attempts:[attempt(1,3,10,30)]},{state:"done",createdAt:0,attempts:[attempt(2,4,15,25)]}]);
 expect(totals.usagePools[0]?.observedDeltaPct).toBeNull();expect(totals.usagePools[0]?.unknownAttempts).toBeGreaterThan(0);
});
test("capacity wait closes when queued work starts",()=>{
 const {ctx,task}=root();ctx.now=task.createdAt+100;updateTask(ctx,task.id,t=>{t.queue={reason:"no_slot",since:ctx.now,position:1};});
 ctx.now+=10;updateTask(ctx,task.id,t=>{t.state="running";delete t.queue;});
 expect(workTree(ctx,task.id).totals.capacityWaitSeconds).toBe(10);
});
test("usage separates pools and treats resets or missing evidence as unknown",()=>{
 const reading=(account:string,window:string,epoch:number,usedPct:number,at:number)=>({account,window,poolId:`${account}:${window}`,resetEpoch:epoch,capturedAt:at,observationId:`${account}-${at}`,stale:false,usedPct,at});
 const attempts=[
  {startedAt:1,endedAt:2,usageAtStart:reading("A","five-hour",100,5,1),usageAtEnd:reading("A","five-hour",100,8,2)},
  {startedAt:3,endedAt:4,usageAtStart:reading("B","daily",200,10,3),usageAtEnd:reading("B","daily",200,12,4)},
  {startedAt:5,endedAt:6,usageAtStart:reading("A","five-hour",100,90,5),usageAtEnd:reading("A","five-hour",300,2,6)},
 ];
 const totals=workTotals([{state:"done",createdAt:0,attempts}]);
 expect(totals.usagePools.find(p=>p.account==="B")?.observedDeltaPct).toBe(2);
 expect(totals.usagePools.some(p=>p.account==="A"&&p.unknownAttempts>0)).toBe(true);
 expect(totals.usageUnknownAttempts).toBe(1);
});
test("retry preserves independent review evidence for each attempt",async()=>{
 const {ctx,task}=root();updateTask(ctx,task.id,t=>{t.state="failed";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now-2,endedAt:ctx.now-1,exitCode:1,timedOut:false,limitHit:false,log:""});});
 await reviewWork(ctx,task.id,false,"Needs correction",readTask(ctx,task.id)!.rev);
 await retryWork(ctx,task.id,{expectRev:readTask(ctx,task.id)!.rev,requestId:"reviewed-retry"},()=>1);
 updateTask(ctx,task.id,t=>{t.state="done";t.attempts.push({executor:"codex",model:null,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:0,timedOut:false,limitHit:false,log:""});});
 await reviewWork(ctx,task.id,true,undefined,readTask(ctx,task.id)!.rev);
 expect(dispatchDatabase(ctx).query<{n:number},[string]>("SELECT count(*) AS n FROM work_reviews WHERE task_id=?").get(task.id)?.n).toBe(2);
 expect(workTree(ctx,task.id).nodes[0]?.attempts).toHaveLength(2);
});
