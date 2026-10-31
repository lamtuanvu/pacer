import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {policyGateFixture} from "./fixtures/policy-host";
import * as tasks from "../src/core/tasks";
import {createTask,listTasksWhere,readTask,updateTask} from "../src/tasks/store";
import {readActivity} from "../src/activity/log";
function fixture(verdict:unknown,delay=0){
 const f=policyGateFixture(verdict,delay),task=createTask(f.ctx,{brief:{goal:"work",repo:f.repo},kind:"debug",requestedExecutor:"codex",timeoutS:60});
 updateTask(f.ctx,task.id,t=>{t.state="failed";t.result={status:"failed",executor:"codex",model:null,files:"",report:"failure",backend:"direct"};});
 return {...f,task:readTask(f.ctx,task.id)!,deps:{delegate:(ctx:typeof f.ctx,input:Parameters<typeof tasks.delegate>[1])=>tasks.delegate(ctx,input,f.spawn)}};
}
for(const verdict of ["accept","reject","send_back","retry"] as const)test(`review ${verdict} veto precedes verdict and retry effects`,async()=>{
 const f=fixture({verdict:"allow"}),path=join(f.dir,"main.ts");
 writeFileSync(path,readFileSync(path,"utf8").replace("result=s.verdict;","result=r.params.decision==='review'?{verdict:'veto',reason:'review blocked'}:{verdict:'allow'};"));
 await expect(tasks.review(f.ctx,f.task.id,{verdict,note:"fix",executor:"codex",expectRev:f.task.rev},f.deps)).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(readTask(f.ctx,f.task.id)).toEqual(f.task);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);
 expect(f.calls().map(line=>JSON.parse(line).decision)).toEqual(["review"]);expect(readActivity(f.ctx,{kinds:["policy"]}).entries).toMatchObject([{level:"warn"}]);
});

test("review retry authorizes review then creation before recording both effects",async()=>{
 const f=fixture({verdict:"allow"});
 const result=await tasks.review(f.ctx,f.task.id,{verdict:"retry",executor:"codex",expectRev:f.task.rev},f.deps);
 expect(f.calls().map(line=>JSON.parse(line).decision)).toEqual(["review","delegate"]);expect(f.launches()).toBe(1);expect(result.retry).toBeDefined();expect(readTask(f.ctx,f.task.id)?.retriedBy).toBe(result.retry?.id);expect(readTask(f.ctx,f.task.id)?.review?.accepted).toBe(false);
});

test("a task race while review policy waits cannot record a stale verdict",async()=>{
 const f=fixture({verdict:"allow"},80),pending=tasks.review(f.ctx,f.task.id,{verdict:"accept",expectRev:f.task.rev},f.deps),until=Date.now()+2000;
 while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 updateTask(f.ctx,f.task.id,t=>{t.reviewRequest={note:"changed",at:f.ctx.now};});
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(f.ctx,f.task.id)?.review).toBeUndefined();expect(f.launches()).toBe(0);
});

test("creation veto after review allow records neither retry nor verdict",async()=>{
 const f=fixture({verdict:"allow"}),path=join(f.dir,"main.ts");
 writeFileSync(path,readFileSync(path,"utf8").replace("result=s.verdict;","result=r.params.decision==='delegate'?{verdict:'veto',reason:'creation blocked'}:{verdict:'allow'};"));
 await expect(tasks.review(f.ctx,f.task.id,{verdict:"send_back",note:"fix",expectRev:f.task.rev},f.deps)).rejects.toMatchObject({code:"not_allowed"});
 expect(readTask(f.ctx,f.task.id)).toEqual(f.task);expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);expect(f.calls().map(line=>JSON.parse(line).decision)).toEqual(["review","delegate"]);
});

test("review freshness is checked again before a retry creation commit",async()=>{
 const f=fixture({verdict:"allow"},60),pending=tasks.review(f.ctx,f.task.id,{verdict:"retry",executor:"codex",expectRev:f.task.rev},f.deps),until=Date.now()+2000;
 while(!f.calls().some(line=>JSON.parse(line).decision==="delegate")&&Date.now()<until)await Bun.sleep(5);
 expect(f.calls().some(line=>JSON.parse(line).decision==="delegate")).toBe(true);updateTask(f.ctx,f.task.id,t=>{t.reviewRequest={note:"changed",at:f.ctx.now};});
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(f.ctx,f.task.id)?.review).toBeUndefined();expect(readTask(f.ctx,f.task.id)?.retriedBy).toBeUndefined();expect(listTasksWhere(f.ctx)).toHaveLength(1);expect(f.launches()).toBe(0);
});

test("invalid review amendments obey actual open and closed modes without changing kind",async()=>{
 for(const mode of ["open","closed"]){
  const f=fixture({verdict:"amend",amend:{kind:"tests"}});writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,plugins:{...f.config.plugins,policy:{mode}}}));
  const pending=tasks.review(f.ctx,f.task.id,{verdict:"accept",expectRev:f.task.rev},f.deps);
  if(mode==="closed")await expect(pending).rejects.toMatchObject({code:"not_allowed"});else await pending;
  expect(readTask(f.ctx,f.task.id)?.kind).toBe("debug");expect(readTask(f.ctx,f.task.id)?.review?.accepted).toBe(mode==="open"?true:undefined);
 }
});

test("managed review veto suppresses learning and managed review events",async()=>{
 const {registerWork,workEvents}=await import("../src/dispatch/work"),{dispatchDatabase}=await import("../src/dispatch/store"),{reviewWork}=await import("../src/core/work");
 const f=fixture({verdict:"veto",reason:"blocked"});registerWork(f.ctx,f.task.id,{});updateTask(f.ctx,f.task.id,t=>{t.attempts.push({executor:"codex",model:null,startedAt:f.ctx.now-1,endedAt:f.ctx.now,exitCode:1,timedOut:false,limitHit:false,log:""});});
 const before=readTask(f.ctx,f.task.id)!,events=workEvents(f.ctx,f.task.id);
 await expect(reviewWork(f.ctx,f.task.id,true,undefined,before.rev)).rejects.toMatchObject({code:"not_allowed"});
 expect(readTask(f.ctx,f.task.id)).toEqual(before);expect(workEvents(f.ctx,f.task.id)).toEqual(events);expect(dispatchDatabase(f.ctx).query<{n:number},[]>("SELECT count(*) AS n FROM work_reviews").get()?.n).toBe(0);
});

test("review policy sees the actual requested review classification",async()=>{
 const f=fixture({verdict:"allow"}),path=join(f.dir,"main.ts");
 writeFileSync(path,readFileSync(path,"utf8").replace("result=s.verdict;","result=r.params.decision==='review'&&r.params.input.kind==='tests'?{verdict:'veto',reason:'classification blocked'}:{verdict:'allow'};"));
 await expect(tasks.review(f.ctx,f.task.id,{verdict:"accept",kind:"tests",expectRev:f.task.rev},f.deps)).rejects.toMatchObject({code:"not_allowed"});
 expect(JSON.parse(f.calls()[0]).input.kind).toBe("tests");expect(readTask(f.ctx,f.task.id)).toEqual(f.task);
});

test("an answer HEAD changing during policy preserves the question and creates no retry",async()=>{
 const {gitRepo,realRun}=await import("./helpers");
 const f=policyGateFixture({verdict:"allow"},100,gitRepo());
 const ctx={...f.ctx,run:realRun};
 const task=createTask(ctx,{brief:{goal:"question",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});
 updateTask(ctx,task.id,t=>{t.state="needs_input";t.worktree=f.repo;t.question={text:"Which?",at:ctx.now};});
 const before=readTask(ctx,task.id)!,pending=tasks.answer(ctx,task.id,"yes",{expectRev:before.rev},{delegate:(c,i)=>tasks.delegate(c,i,f.spawn)});
 const until=Date.now()+2000;while(!f.calls().length&&Date.now()<until)await Bun.sleep(5);expect(f.calls()).toHaveLength(1);
 const changed=await realRun(["git","-C",f.repo,"-c","user.name=Pacer","-c","user.email=pacer@localhost","commit","--allow-empty","-m","changed"],10000);expect(changed.code).toBe(0);
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(ctx,task.id)).toEqual(before);expect(listTasksWhere(ctx)).toHaveLength(1);expect(f.launches()).toBe(0);
});
