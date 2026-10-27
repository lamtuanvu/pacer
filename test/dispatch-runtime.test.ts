import { expect,test } from "bun:test";
import { fakeCtx,tmpDir } from "./helpers";
import { createTask,updateTask } from "../src/tasks/store";
import { registerWork, workTree } from "../src/dispatch/work";
import { reserveDispatch, releaseDispatch } from "../src/dispatch/runtime";
import { dispatchDatabase } from "../src/dispatch/store";
import { candidate,request } from "./fixtures/dispatch";
import { runDecision,ladderEngine } from "../src/dispatch/engines";
import { authorizeEnforcementToken } from "../src/dispatch/enforcement-token";
import { certifyExecutor, resolveEnforcementTarget, enforcementExclusion } from "../src/dispatch/enforcement";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../src/types";
import type { Strategy } from "../src/config/strategy";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
async function certifiedClaude(ctx:Ctx,strategy:Strategy,repo:string){
 const binary=join(ctx.home,"claude-bin");writeFileSync(binary,"claude");
 ctx.which=(name)=>name==="claude"?binary:null;
 const previousRun=ctx.run;
 ctx.run=(argv,timeout,options)=>argv[0]===binary?Promise.resolve({code:0,stdout:"2.1.281 (Claude Code)",stderr:""}):previousRun(argv,timeout,options);
 const resolved=await resolvePolicyRepoInput(ctx,repo);
 const target=await resolveEnforcementTarget(ctx,strategy,"claude-code",resolved.path);
 await certifyExecutor(ctx,target,async()=>({attempted:true,blocked:true,childStarted:false,entries:["Agent","Task"]}));
 expect(await enforcementExclusion(ctx,strategy,"claude-code",resolved.path)).toBeNull();
}
test("shared-pool reservations prevent simultaneous over-admission",async()=>{
 const ctx=fakeCtx(),repo=tmpDir();const make=()=>createTask(ctx,{brief:{goal:"x",repo},kind:"feature",requestedExecutor:null,timeoutS:600});
 const a=make(),b=make();registerWork(ctx,a.id,{estimatePct:30});registerWork(ctx,b.id,{estimatePct:30});
 const c=candidate("runner",50),p=await runDecision(request([c]),ladderEngine);
 p.uncertainty.push("Preview uses cached observations and makes no reservation; dispatch may differ.");
 expect(reserveDispatch(ctx,a.id,c,p)).toBe(true);updateTask(ctx,a.id,t=>{t.state="running";});
 const saved=dispatchDatabase(ctx).query<{data:string},[string]>("SELECT data FROM work_decisions WHERE task_id=?").get(a.id);
 expect((JSON.parse(saved!.data) as {uncertainty:string[]}).uncertainty).not.toContain("Preview uses cached observations and makes no reservation; dispatch may differ.");
 expect(reserveDispatch(ctx,b.id,c,p)).toBe(false);releaseDispatch(ctx,a.id);expect(reserveDispatch(ctx,b.id,c,p)).toBe(true);
});
test("queued managed work explains missing native control",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"claude-code",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{codex:{models:[{id:"provider/deep",tier:"frontier"}]}}},"test");
 const binary=join(ctx.home,"codex-bin");writeFileSync(binary,"codex");ctx.which=name=>name==="codex"?binary:null;
 const previousRun=ctx.run;ctx.run=(argv,timeout,options)=>argv[0]===binary?Promise.resolve({code:0,stdout:"codex-cli 0.164.0",stderr:""}):previousRun(argv,timeout,options);
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id);
 const result=await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async(statusCtx)=>({generatedAt:statusCtx.now,strategy:"test",planner:"claude-code",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"codex",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),runAttempt:async()=>{throw Error("uncertified runner launched")},verifyRepo:async()=>({files:""})});
 expect(result.state).toBe("queued");expect(result.queue?.detail).toContain("Native subagent control");
});
test("work runner executes the model selected by the decision engine",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"codex",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{"claude-code":{models:[{id:"provider/fast",tier:"small"},{id:"provider/deep",tier:"frontier",tools:true}]}},dispatch:{timeoutMs:5000}},"test");
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id,{requirements:{minTier:"medium",tools:true}});
 await certifiedClaude(ctx,s,repo);
 const launched:string[]=[];
 const result=await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async(statusCtx)=>({generatedAt:statusCtx.now,strategy:"test",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"claude-code",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
 runAttempt:async(runCtx,cfg)=>{
  expect(runCtx.env.PACER_ENFORCEMENT_MODE).toBe("strict");
  expect(authorizeEnforcementToken({...runCtx,now:Date.now()/1000},runCtx.env.PACER_ENFORCEMENT_TOKEN??"")).toMatchObject({taskId:task.id,attempt:1});
  expect(runCtx.env.PACER_WORK_GRANT).toBeUndefined();
  launched.push(cfg.model??"");return{exec:{code:0,stdout:"ok",stderr:"",timedOut:false},report:"ok",attempt:{executor:cfg.id,model:cfg.model,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:0,timedOut:false,limitHit:false,log:""}};
 },verifyRepo:async()=>({files:""})});
 expect(result.state).toBe("done");expect(launched).toEqual(["provider/deep"]);expect(result.attempts[0].model).toBe("provider/deep");
 expect(workTree(ctx,task.id).nodes[0]!.decisions[0]!.enforcement).toMatchObject({policy:"strict",adapter:"claude-code",version:"2.1.281",account:"claude-code"});
});
test("a guard report failure is recorded as enforcement loss after the attempt",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"codex",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{"claude-code":{models:[{id:"provider/deep",tier:"frontier"}]}},dispatch:{timeoutMs:5000}},"test");
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id);
 await certifiedClaude(ctx,s,repo);
 await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async(statusCtx)=>({generatedAt:statusCtx.now,strategy:"test",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"claude-code",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
  runAttempt:async(runCtx,cfg)=>{writeFileSync(runCtx.env.PACER_GUARD_FAILURE_MARKER!,"guard-report-failed");return{exec:{code:0,stdout:"ok",stderr:"",timedOut:false},report:"ok",attempt:{executor:cfg.id,model:cfg.model,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:0,timedOut:false,limitHit:false,log:""}};},verifyRepo:async()=>({files:""})});
 const decision=workTree(ctx,task.id).nodes[0]!.decisions[0]!;
 expect(decision.enforcement?.loss?.reason).toContain("could not report");
 expect(dispatchDatabase(ctx).query<{kind:string},[]>("SELECT kind FROM work_events").all().map(row=>row.kind)).toContain("enforcement.lost");
});
test("managed work honors the cumulative attempt cap inside one runner invocation",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"codex",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{"claude-code":{models:[{id:"provider/fast",tier:"small"},{id:"provider/deep",tier:"frontier"}]}},dispatch:{timeoutMs:5000}},"test");
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id,{maxAttempts:3});
 await certifiedClaude(ctx,s,repo);
 updateTask(ctx,task.id,t=>{for(let i=0;i<2;i++)t.attempts.push({executor:"prior",model:null,startedAt:ctx.now-4+i,endedAt:ctx.now-3+i,exitCode:1,timedOut:false,limitHit:true,log:""});});
 const launched:string[]=[];
 const result=await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async(statusCtx)=>({generatedAt:statusCtx.now,strategy:"test",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"claude-code",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
 runAttempt:async(_c,cfg)=>{launched.push(cfg.id);return{exec:{code:1,stdout:"",stderr:"quota exceeded",timedOut:false},report:"quota",attempt:{executor:cfg.id,model:cfg.model,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:1,timedOut:false,limitHit:true,log:""}};},verifyRepo:async()=>({files:""})});
 expect(launched, JSON.stringify({state:result.state,queue:result.queue,report:result.result?.report,decisions:dispatchDatabase(ctx).query("SELECT data FROM work_decisions WHERE task_id=?").get(task.id)})).toHaveLength(1);expect(result.attempts).toHaveLength(3);
});
