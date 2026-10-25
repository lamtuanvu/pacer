import {expect,test} from "bun:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fakeCtx,tmpDir} from "./helpers";
import {createTask,updateTask} from "../src/tasks/store";
import {registerWork,workTree} from "../src/dispatch/work";
import {applyLearnedFit,dispatchAnalytics,dispatchSettingsHash,recordWorkReview,resetLearning} from "../src/dispatch/learning";
import {loadStrategy} from "../src/config/strategy";
import {candidate} from "./fixtures/dispatch";

test("twenty comparable independent reviews enable opt-in learned fit; reset preserves work history",()=>{
 const ctx=fakeCtx({now:Date.now()/1000}),repo=tmpDir();mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}, codex: {}}\ndispatch:\n  learning: {enabled: true}\n");
 const strategy=loadStrategy(ctx),c={...candidate("codex"),account:"codex",binding:{kind:"exact" as const,id:"provider/deep"},actualModel:"provider/deep"};
 let first="";
 for(let i=0;i<20;i++){
  const task=createTask(ctx,{brief:{goal:`sample ${i}`,repo},kind:"debug",requestedExecutor:null,timeoutS:60});if(!first)first=task.id;
  registerWork(ctx,task.id,{kind:"debug",difficulty:"standard"});
  updateTask(ctx,task.id,t=>{t.state="done";t.attempts.push({executor:"codex",model:"provider/deep",actualModel:"provider/deep",dispatchSettingsHash:dispatchSettingsHash(strategy,"codex"),startedAt:ctx.now-20,endedAt:ctx.now-10,exitCode:0,timedOut:false,limitHit:false,log:""});t.review={accepted:i!==0,kind:"debug",note:null,at:ctx.now};});
  recordWorkReview(ctx,task.id,"human");
  const fit=applyLearnedFit(ctx,strategy,[c],"debug","standard")[0].learnedFit;
  if(i===18)expect(fit).toBeUndefined();
 }
 expect(applyLearnedFit(ctx,strategy,[c],"debug","standard")[0].learnedFit?.sampleCount).toBe(20);
 expect(dispatchAnalytics(ctx,{repo}).groups[0]).toMatchObject({sampleCount:20,accepted:19,averageDurationS:10,averageUsagePct:null});
 const revision=resetLearning(ctx,repo,true,0);
 expect(()=>resetLearning(ctx,repo,false,0)).toThrow();
 expect(revision).toBeGreaterThan(0);
 expect(applyLearnedFit(ctx,strategy,[c],"debug","standard")[0].learnedFit).toBeUndefined();
 expect(dispatchAnalytics(ctx,{repo}).totalReviews).toBe(0);
 expect(workTree(ctx,first).nodes).toHaveLength(1);
});
test("unknown actual models and old reviews cannot train a current candidate",()=>{
 const ctx=fakeCtx({now:Date.now()/1000});mkdirSync(ctx.pacerHome,{recursive:true});
 writeFileSync(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders: {claude-code: {}, codex: {}}\ndispatch:\n  learning: {enabled: true, maxAgeDays: 30}\n");
 const strategy=loadStrategy(ctx),candidateModel={...candidate("codex"),account:"codex",actualModel:"provider/deep"};
 expect(applyLearnedFit(ctx,strategy,[candidateModel],"debug","standard")[0].learnedFit).toBeUndefined();
 const task=createTask(ctx,{brief:{goal:"old",repo:tmpDir()},kind:"debug",requestedExecutor:null,timeoutS:60});
 registerWork(ctx,task.id,{kind:"debug"});
 updateTask(ctx,task.id,t=>{t.state="done";t.attempts.push({executor:"codex",model:"provider/deep",actualModel:null,dispatchSettingsHash:dispatchSettingsHash(strategy,"codex"),startedAt:ctx.now-20,endedAt:ctx.now-10,exitCode:0,timedOut:false,limitHit:false,log:""});t.review={accepted:true,kind:"debug",note:null,at:ctx.now-40*86400};});
 recordWorkReview(ctx,task.id,"human");
 expect(dispatchAnalytics(ctx).groups[0]?.model).toBeNull();
 expect(applyLearnedFit(ctx,strategy,[candidateModel],"debug","standard")[0].learnedFit).toBeUndefined();
});
