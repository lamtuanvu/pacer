import { afterEach as afterUsageFixture } from "bun:test";
import { fakeCtx, cleanupUsageFixtures } from "./usage-plugin-fixtures";
afterUsageFixture(cleanupUsageFixtures);
import { test, expect } from 'bun:test';
import { eligibility } from './fixtures/eligibility';

import { validateStrategy } from '../src/config/strategy';
import { defaultHooks } from '../src/classify/hooks';
import { runTask } from '../src/tasks/runner';
import { createTask } from '../src/tasks/store';

test('uncertain fallback can run after hook excludes eligible alternative', async () => {
 const ctx=fakeCtx();
 const s=validateStrategy({planner:'claude-code',providers:{'claude-code':{},codex:{},cursor:{}},routing:[{default:['codex','cursor']}]},'/x');
 const task=createTask(ctx,{brief:{goal:'g',repo:ctx.home},kind:'tests',requestedExecutor:null,timeoutS:60});
 let launches=0;
 const result=await runTask(ctx,task.id,{
  loadStrategy:()=>s,
  computeStatus:async()=>({generatedAt:ctx.now,strategy:'default',planner:'claude-code',mode:'normal',disabled:false,calendarPace:true,providers:Object.keys(s.providers).map(id=>({id,eligibility:eligibility(id==='cursor'?'uncertain':'eligible'),usage:'quota',windows:[],binding:null,verdict:'ON_PACE',installed:true,stale:false})),executors:{ranked:[],excluded:[]}}),
  hooks:{...defaultHooks,filterExecutors:async()=>['cursor']},
  runAttempt:async()=>{launches++;return {exec:{code:0,stdout:'',stderr:'',timedOut:false},report:'ok',attempt:{executor:'cursor',model:null,startedAt:1,endedAt:2,exitCode:0,timedOut:false,limitHit:false,log:''}};},
  verifyRepo:async()=>({files:''})
 });
 console.log(JSON.stringify({launches,state:result.state,result:result.result}));
 expect(launches).toBe(1);
});

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLoginIndicators } from "./helpers";
import { computeStatus } from "../src/engine/status";
import { readCodex } from "../src/usage/codex";
import { accountEvidenceScope, readEvidence, recordExecutionEvidence } from "../src/core/evidence";
import { markAuthFailed } from "../src/usage/auth";
import { markExhausted } from "../src/usage/reactive";
import { queueStrategy, queueTask, queueDeps } from "./queue-helpers";
import { updateTask } from "../src/tasks/store";
import { evaluateEligibility } from "../src/engine/eligibility";

test("unterminated quota events cannot clear persisted exhaustion", async () => {
 const ctx=withLoginIndicators(fakeCtx()), s=queueStrategy();
 const dir=join(ctx.home,".codex/sessions");mkdirSync(dir,{recursive:true});
 const path=join(dir,"rollout-review.jsonl");
 const event=(at:number,used:number)=>JSON.stringify({timestamp:new Date(at*1000).toISOString(),rate_limits:{primary:{used_percent:used,window_minutes:300,resets_in_seconds:3600}}});
 writeFileSync(path,event(ctx.now-10,100)+"\n");
 const observe=async()=>{const reading=await readCodex(ctx,s.accounts.codex); return (await computeStatus(ctx,s,{profile:null,readings:new Map([["codex",reading]])})).providers.find(p=>p.id==="codex")!.eligibility;};
 expect((await observe())?.state).toBe("ineligible");
 appendFileSync(path,event(ctx.now-1,0));
 expect((await observe())?.state).toBe("ineligible");
 appendFileSync(path,"invalid\n");
 expect((await observe())?.state).toBe("ineligible");
 appendFileSync(path,event(ctx.now,0)+"\n");
 expect((await observe())?.state).toBe("eligible");
});

test("unbound legacy sidecars cannot become current facts in a replacement account",async()=>{
 const ctx=withLoginIndicators(fakeCtx()),s=queueStrategy();
 markAuthFailed(ctx,"codex","authentication failed");markExhausted(ctx,"codex",ctx.now+3600);
 const home=join(ctx.home,"replacement");mkdirSync(home);writeFileSync(join(home,"auth.json"),"{}");
 s.accounts.codex={...s.accounts.codex,home,source:"pacer"};
 const reading={capturedAt:ctx.now-1,stale:false,windows:[{name:"5h",usedPct:10,resetsAt:ctx.now+3600,lengthS:18000,paced:false}]};
 const st=await computeStatus(ctx,s,{profile:null,readings:new Map([["codex",reading]])});
 expect(st.providers.find(p=>p.id==="codex")?.eligibility?.state).toBe("eligible");
});

test("free uncertain fallback launches when eligible executor has no slot",async()=>{
 const ctx=fakeCtx(),s=queueStrategy(true),active=queueTask(ctx,"active"),task=queueTask(ctx,"fallback");
 updateTask(ctx,active.id,t=>{t.state="running";t.executor="codex";t.runnerPid=process.pid;});
 const deps=queueDeps(s),status=deps.computeStatus,attempt=deps.runAttempt!;let launches=0;
 deps.computeStatus=async(...args)=>{const st=await status(...args);st.providers=st.providers.map(p=>({...p,eligibility:eligibility(p.id==="cursor"?"uncertain":"eligible")}));return st;};
 deps.runAttempt=async(...args)=>{launches++;return attempt(...args);};
 const result=await runTask(ctx,task.id,deps);expect(launches).toBe(1);expect(result.executor).toBe("cursor");expect(result.attempts[0].routing?.fallback).toBe("uncertain");
});

test("actual execution failure retains model and runner scope",async()=>{
 const ctx=fakeCtx(),s=queueStrategy();s.runners.codex.model="model-alpha";s.providers.codex.model="model-alpha";
 const task=queueTask(ctx,"model-specific", "codex"),deps=queueDeps(s);
 deps.runAttempt=async()=>({exec:{code:1,stdout:"",stderr:"Subscription required for model-alpha",timedOut:false},report:"subscription required",attempt:{executor:"codex",model:"model-alpha",startedAt:ctx.now-30,endedAt:ctx.now,exitCode:1,timedOut:false,limitHit:false,log:""}});
 await runTask(ctx,task.id,deps);
 const scope=accountEvidenceScope(s.accounts.codex,s.hosts),evidence=readEvidence(ctx,scope).evidence;
 expect(evidence.facts.availability[0].scope).toMatchObject({runner:"codex",model:"model-alpha"});
 const other=evaluateEligibility({now:ctx.now,scope:{...scope,runner:"codex",model:"model-beta"},usage:"quota",allowPaid:false,evidence,restrictions:[]});
 expect(other.availability).not.toBe("unavailable");
 await recordExecutionEvidence({...ctx,now:ctx.now+1},{...scope,runner:"codex",model:"model-beta",host:"elsewhere"},{endedAt:ctx.now+1,exitCode:0,timedOut:false,classification:"success"});
 const after=readEvidence(ctx,scope).evidence;
 expect(evaluateEligibility({now:ctx.now+1,scope:{...scope,runner:"codex",model:"model-alpha",host:"local"},usage:"quota",allowPaid:false,evidence:after,restrictions:[]}).availability).toBe("unavailable");
});
