import { expect,test } from "bun:test";
import { fakeCtx,tmpDir } from "./helpers";
import { createTask,updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { reserveDispatch, releaseDispatch } from "../src/dispatch/runtime";
import { dispatchDatabase } from "../src/dispatch/store";
import { candidate,request } from "./fixtures/dispatch";
import { runDecision,ladderEngine } from "../src/dispatch/engines";
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
test("work runner executes the model selected by the decision engine",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"claude-code",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{codex:{models:[{id:"provider/fast",tier:"small"},{id:"provider/deep",tier:"frontier",tools:true}]}},dispatch:{timeoutMs:5000}},"test");
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id,{requirements:{minTier:"medium",tools:true}});
 const launched:string[]=[];
 const result=await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async()=>({generatedAt:Date.now()/1000,strategy:"test",planner:"claude-code",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"codex",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
 runAttempt:async(_c,cfg)=>{launched.push(cfg.model??"");return{exec:{code:0,stdout:"ok",stderr:"",timedOut:false},report:"ok",attempt:{executor:cfg.id,model:cfg.model,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:0,timedOut:false,limitHit:false,log:""}};},verifyRepo:async()=>({files:""})});
 expect(result.state).toBe("done");expect(launched).toEqual(["provider/deep"]);expect(result.attempts[0].model).toBe("provider/deep");
});
test("managed work honors the cumulative attempt cap inside one runner invocation",async()=>{
 const {validateStrategy}=await import("../src/config/strategy");const {runTask}=await import("../src/tasks/runner");const {defaultHooks}=await import("../src/classify/hooks");
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();
 const s=validateStrategy({planner:"claude-code",accounts:{"claude-code":{kind:"claude"},codex:{kind:"codex",usage:"unmetered"}},runners:{codex:{models:[{id:"provider/fast",tier:"small"},{id:"provider/deep",tier:"frontier"}]}},dispatch:{timeoutMs:5000}},"test");
 const task=createTask(ctx,{brief:{goal:"debug",repo},kind:"debug",requestedExecutor:null,timeoutS:60});registerWork(ctx,task.id,{maxAttempts:3});
 updateTask(ctx,task.id,t=>{for(let i=0;i<2;i++)t.attempts.push({executor:"prior",model:null,startedAt:ctx.now-4+i,endedAt:ctx.now-3+i,exitCode:1,timedOut:false,limitHit:true,log:""});});
 const launched:string[]=[];
 const result=await runTask(ctx,task.id,{loadStrategy:()=>s,hooks:defaultHooks,computeStatus:async()=>({generatedAt:Date.now()/1000,strategy:"test",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[{id:"codex",usage:"unmetered",windows:[],binding:null,verdict:"OK",installed:true,stale:false}],executors:{ranked:[],excluded:[]}}),
 runAttempt:async(_c,cfg)=>{launched.push(cfg.id);return{exec:{code:1,stdout:"",stderr:"quota exceeded",timedOut:false},report:"quota",attempt:{executor:cfg.id,model:cfg.model,startedAt:ctx.now,endedAt:ctx.now+1,exitCode:1,timedOut:false,limitHit:true,log:""}};},verifyRepo:async()=>({files:""})});
 expect(launched, JSON.stringify({state:result.state,queue:result.queue,report:result.result?.report,decisions:dispatchDatabase(ctx).query("SELECT data FROM work_decisions WHERE task_id=?").get(task.id)})).toHaveLength(1);expect(result.attempts).toHaveLength(3);
});
