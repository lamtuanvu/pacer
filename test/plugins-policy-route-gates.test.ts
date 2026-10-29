import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {policyGateFixture} from "./fixtures/policy-host";
import {queueDeps} from "./queue-helpers";
import {registerWork} from "../src/dispatch/work";
import {dispatchConfigSchema} from "../src/dispatch/types";
import {dispatchDatabase} from "../src/dispatch/store";
import {loadStrategy} from "../src/config/strategy";
import {createTask,readTask,updateTask} from "../src/tasks/store";
import {runTask} from "../src/tasks/runner";
import {drainQueue} from "../src/tasks/drain";
import {tmpDir} from "./helpers";
import {eligibility} from "./fixtures/eligibility";
/** Existing managed work keeps cooperative enforcement (#392); these cases test policy gates, not certification. */
function cooperativeWork(ctx:Parameters<typeof registerWork>[0],id:string){
 registerWork(ctx,id,{});
 dispatchDatabase(ctx).run("UPDATE work_nodes SET options=json_set(options,'$.delegationEnforcement','cooperative') WHERE task_id=?",[id]);
}
function setup(verdict:unknown,requestedExecutor:string|null=null){
 const f=policyGateFixture(verdict);writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,providers:{...f.config.providers,cursor:{},agy:{}},pacing:{policy:"priority"}}));
 const strategy=loadStrategy(f.ctx),deps=queueDeps(strategy),calls:string[]=[];
 const status=deps.computeStatus;deps.computeStatus=async(...args)=>{const s=await status(...args);return {...s,providers:s.providers.map(p=>({...p,eligibility:eligibility()}))};};
 const attempt=deps.runAttempt!;deps.runAttempt=async(...args)=>{calls.push(args[1].id);return attempt(...args);};
 const task=createTask(f.ctx,{brief:{goal:"work",repo:f.repo},kind:null,requestedExecutor,timeoutS:60});
 return {...f,deps,task,policyCalls:f.calls,calls};
}

test("actual runner policy veto happens before first attempt including explicit executor",async()=>{
 for(const requested of [null,"codex"]){
  const f=setup({verdict:"veto",reason:"route blocked"},requested);
  const result=await runTask(f.ctx,f.task.id,f.deps);
  expect(result.state).toBe("failed");expect(result.result?.report).toContain("plugin fx-policy");expect(result.attempts).toEqual([]);expect(f.calls).toEqual([]);expect(f.launches()).toBe(0);
 }
});

test("route exclusion removes explicit executor and attributes fallback routing",async()=>{
 const f=setup({verdict:"amend",amend:{exclude:["codex"]}},"codex");
 const result=await runTask(f.ctx,f.task.id,f.deps);
 expect(f.calls).toEqual(["cursor"]);expect(result.attempts[0]?.routing?.skipped).toContainEqual({executor:"codex",reason:"excluded by plugin fx-policy"});
 expect(JSON.parse(f.policyCalls()[0]).input.candidates).toContain("codex");
});

test("fallback re-evaluates remaining candidates without re-adding earlier policy excludes",async()=>{
 const f=setup({verdict:"amend",amend:{exclude:["codex"]}});
 const attempt=f.deps.runAttempt!;let first=true;
 f.deps.runAttempt=async(...args)=>{
  const result=await attempt(...args);
  if(first){first=false;writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:0}));result.attempt.limitHit=true;result.exec.code=1;result.report="limit";}
  return result;
 };
 await runTask(f.ctx,f.task.id,f.deps);
 expect(f.calls).toEqual(["cursor","agy"]);
 expect(f.policyCalls().map(line=>JSON.parse(line).input.candidates)).toEqual([["codex","cursor","agy"],["agy"]]);
});

test("queue-drain veto preserves waiting task and never reserves or launches",async()=>{
 const f=setup({verdict:"veto",reason:"route blocked"});
 updateTask(f.ctx,f.task.id,t=>{t.queue={reason:"no_slot",since:f.ctx.now,position:1};});
 await expect(drainQueue(f.ctx,f.spawn,f.deps)).rejects.toMatchObject({code:"not_allowed",hint:"plugin fx-policy"});
 expect(readTask(f.ctx,f.task.id)).toMatchObject({state:"queued",queue:{reason:"no_slot"}});expect(readTask(f.ctx,f.task.id)?.executor).toBeUndefined();expect(f.launches()).toBe(0);
});

test("queue-drain excludes a runner before provisional reservation",async()=>{
 const f=setup({verdict:"amend",amend:{exclude:["codex"]}});
 updateTask(f.ctx,f.task.id,t=>{t.queue={reason:"no_slot",since:f.ctx.now,position:1};});
 expect(await drainQueue(f.ctx,f.spawn,f.deps)).toEqual([f.task.id]);expect(readTask(f.ctx,f.task.id)?.executor).toBe("cursor");expect(f.launches()).toBe(1);
});


test("continuing a stored active attempt never re-runs route policy",async()=>{
 const f=setup({verdict:"veto",reason:"must not run"}),dir=tmpDir();
 writeFileSync(join(dir,"exit"),"0");writeFileSync(join(dir,"stdout"),"completed");writeFileSync(join(dir,"stderr"),"");
 updateTask(f.ctx,f.task.id,t=>{t.state="running";t.runnerPid=999999;t.run={dir,attempt:1,executor:"codex",startedAt:f.ctx.now,mode:"current",workdir:f.repo,logFile:join(dir,"attempt.log")};});
 const result=await runTask(f.ctx,f.task.id,f.deps);
 expect(result.state).toBe("done");expect(result.attempts).toHaveLength(1);expect(f.policyCalls()).toEqual([]);expect(f.calls).toEqual([]);
});


test("managed model reranking cannot re-add an excluded runner and advances to the next engine choice",async()=>{
 const f=setup({verdict:"amend",amend:{exclude:["codex"]}});
 const path=join(f.dir,"main.ts");writeFileSync(path,readFileSync(path,"utf8").replace("result=s.verdict;","result=s.verdict;if(r.params.decision==='route'&&s.verdict?.amend?.exclude)result={...s.verdict,amend:{exclude:s.verdict.amend.exclude.filter(id=>r.params.input.candidates.includes(id))}};"));
 const strategy=f.deps.loadStrategy(f.ctx);
 for(const account of Object.values(strategy.accounts))account.usage="unmetered";
 for(const provider of Object.values(strategy.providers))provider.usage="unmetered";
 const status=f.deps.computeStatus;f.deps.computeStatus=async(...args)=>{const current=await status(...args);return {...current,generatedAt:args[0].now,providers:current.providers.map(p=>({...p,usage:"unmetered" as const}))};};
 strategy.dispatch=dispatchConfigSchema.parse({steps:[{id:"first",candidates:{executors:["codex"]}},{id:"second",candidates:{executors:["cursor"]}},{id:"third",candidates:{executors:["agy"]}}]});
 cooperativeWork(f.ctx,f.task.id);
 const result=await runTask(f.ctx,f.task.id,f.deps);
 expect(result.state,JSON.stringify({task:result,calls:f.calls,policy:f.policyCalls()})).toBe("done");expect(f.calls).toEqual(["cursor"]);
 expect(f.policyCalls().map(line=>JSON.parse(line).input.candidates)).toEqual([["codex"],["cursor"]]);
 const decisions=dispatchDatabase(f.ctx).query<{data:string},[string]>("SELECT data FROM work_decisions WHERE task_id=?").all(f.task.id);
 expect(decisions).toHaveLength(1);expect(JSON.parse(decisions[0].data).request.candidates.some((candidate:{runner:string})=>candidate.runner==="codex")).toBe(false);
});

test("capacity is rechecked after policy before executor selection",async()=>{
 const f=setup({verdict:"allow"});writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:60}));
 const pending=runTask(f.ctx,f.task.id,f.deps),until=Date.now()+2000;while(!f.policyCalls().length&&Date.now()<until)await Bun.sleep(5);
 const blocker=createTask(f.ctx,{brief:{goal:"other",repo:f.repo},kind:null,requestedExecutor:"codex",timeoutS:60});
 updateTask(f.ctx,blocker.id,t=>{t.state="running";t.executor="codex";});
 const result=await pending;expect(result.state).toBe("done");expect(f.calls).toEqual(["cursor"]);
});

test("task cancellation while queue policy waits prevents reservation and launch",async()=>{
 const f=setup({verdict:"allow"});writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:60}));
 updateTask(f.ctx,f.task.id,t=>{t.queue={reason:"no_slot",since:f.ctx.now,position:1};});
 const pending=drainQueue(f.ctx,f.spawn,f.deps),until=Date.now()+2000;while(!f.policyCalls().length&&Date.now()<until)await Bun.sleep(5);
 updateTask(f.ctx,f.task.id,t=>{t.state="stopped";});
 await expect(pending).rejects.toMatchObject({code:"conflict"});expect(readTask(f.ctx,f.task.id)?.state).toBe("stopped");expect(f.launches()).toBe(0);
});

test("malformed route amendments follow actual open and closed gate modes",async()=>{
 for(const mode of ["open","closed"]){
  const f=setup({verdict:"amend",amend:{exclude:["invented"]}});
  writeFileSync(join(f.ctx.pacerHome,"strategy.yaml"),JSON.stringify({...f.config,providers:{...f.config.providers,cursor:{},agy:{}},pacing:{policy:"priority"},plugins:{...f.config.plugins,policy:{mode}}}));
  const result=await runTask(f.ctx,f.task.id,f.deps);
  expect(result.state).toBe(mode==="open"?"done":"failed");expect(f.calls).toEqual(mode==="open"?["codex"]:[]);
 }
});

function managedRouting(f:ReturnType<typeof setup>) {
 const strategy=f.deps.loadStrategy(f.ctx);
 for(const account of Object.values(strategy.accounts))account.usage="unmetered";
 for(const provider of Object.values(strategy.providers))provider.usage="unmetered";
 strategy.dispatch=dispatchConfigSchema.parse({steps:[{id:"only-codex",candidates:{executors:["codex"]}}]});
 const status=f.deps.computeStatus;f.deps.computeStatus=async(...args)=>{const current=await status(...args);return {...current,generatedAt:args[0].now,providers:current.providers.map(p=>({...p,usage:"unmetered" as const}))};};
 cooperativeWork(f.ctx,f.task.id);
}

test("failed pre-launch eligibility retires a speculative managed reservation",async()=>{
 const f=setup({verdict:"allow"});managedRouting(f);const status=f.deps.computeStatus;let checks=0,reserved=0;
 f.deps.computeStatus=async(...args)=>{const current=await status(...args);if(++checks<2)return current;reserved=Math.max(reserved,dispatchDatabase(f.ctx).query<{n:number},[string]>("SELECT count(*) AS n FROM work_reservations WHERE task_id=?").get(f.task.id)?.n??0);return {...current,providers:current.providers.map(p=>({...p,eligibility:{...eligibility("ineligible"),availability:"unavailable" as const},verdict:"EXHAUSTED" as const}))};};
 const result=await runTask(f.ctx,f.task.id,f.deps);
 expect(result.state).toBe("queued");expect(f.calls).toEqual([]);expect(reserved).toBe(1);
 expect(dispatchDatabase(f.ctx).query<{n:number},[string]>("SELECT count(*) AS n FROM work_reservations WHERE task_id=?").get(f.task.id)?.n).toBe(0);
});

test("a duplicate runner cannot retire another invocation's active reservation",async()=>{
 const f=setup({verdict:"allow"});managedRouting(f);const attempt=f.deps.runAttempt!;let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 f.deps.runAttempt=async(...args)=>{entered();await gate;return attempt(...args);};
 const first=runTask(f.ctx,f.task.id,f.deps);await ready;
 try {
  expect((await runTask(f.ctx,f.task.id,f.deps)).state).toBe("running");
  expect(dispatchDatabase(f.ctx).query<{n:number},[string]>("SELECT count(*) AS n FROM work_reservations WHERE task_id=?").get(f.task.id)?.n).toBe(1);
 } finally {release();await first;}
});

test("retired policy generation during route reports conflict before attempts",async()=>{
 const {pluginRegistry}=await import("../src/plugins");
 const f=setup({verdict:"allow"});writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:100}));
 const pending=runTask(f.ctx,f.task.id,f.deps),until=Date.now()+2000;while(!f.policyCalls().length&&Date.now()<until)await Bun.sleep(5);
 const path=join(f.dir,"pacer-plugin.json"),manifest=JSON.parse(readFileSync(path,"utf8"));manifest.contributes.policy={revision:2};writeFileSync(path,JSON.stringify(manifest));pluginRegistry(f.ctx).list(f.ctx);
 const result=await pending;expect(result.state).toBe("failed");expect(result.result?.report).toContain("Policy context changed");expect(f.calls).toEqual([]);expect(result.attempts).toEqual([]);
});

const admissionLeasePresent=async(ctx:ReturnType<typeof setup>["ctx"],lease:string)=>{
 const {withDesktopCoordinator}=await import("../src/update/desktop/coordinator");
 return withDesktopCoordinator(ctx,db=>{
  const row=db.query<{state:string},[]>("SELECT state FROM admission WHERE id=1").get();
  return !!row&&JSON.parse(row.state).leases.some((entry:{id:string})=>entry.id===lease);
 });
};

test("a duplicate sharing the winning inherited lease cannot finish that lease",async()=>{
 const {beginWorkSync}=await import("../src/update/desktop/admission");
 const f=setup({verdict:"allow"});managedRouting(f);const attempt=f.deps.runAttempt!;let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 f.deps.runAttempt=async(...args)=>{entered();await gate;return attempt(...args);};
 const lease=beginWorkSync(f.ctx,{kind:"task",id:f.task.id,label:"Winning inherited task"}),ctx={...f.ctx,env:{...f.ctx.env,PACER_ADMISSION_TASK:f.task.id,PACER_ADMISSION_LEASE:lease}};
 const first=runTask(ctx,f.task.id,f.deps);await ready;
 try {await runTask(ctx,f.task.id,f.deps);expect(await admissionLeasePresent(ctx,lease)).toBe(true);}
 finally {release();await first;}
 expect(await admissionLeasePresent(ctx,lease)).toBe(false);
});

test("a duplicate during policy does not write a revision or invalidate the winner",async()=>{
 const f=setup({verdict:"allow"});writeFileSync(join(f.dir,"settings.json"),JSON.stringify({verdict:{verdict:"allow"},delay:80}));
 const first=runTask(f.ctx,f.task.id,f.deps),until=Date.now()+2000;while(!f.policyCalls().length&&Date.now()<until)await Bun.sleep(5);
 const revision=readTask(f.ctx,f.task.id)!.rev;
 try {await runTask(f.ctx,f.task.id,f.deps);expect(readTask(f.ctx,f.task.id)?.rev).toBe(revision);}
 finally {await first;}
 expect((await first).state).toBe("done");expect(f.calls).toEqual(["codex"]);expect(f.policyCalls()).toHaveLength(1);
});

test("a newly inherited pending lease is cleaned when no task can be claimed",async()=>{
 const {beginWorkSync}=await import("../src/update/desktop/admission");
 const f=setup({verdict:"allow"}),id="t-20000101-000000-abcd",lease=beginWorkSync(f.ctx,{kind:"task",id,label:"Missing inherited task"});
 const ctx={...f.ctx,env:{...f.ctx.env,PACER_ADMISSION_TASK:id,PACER_ADMISSION_LEASE:lease}};
 await expect(runTask(ctx,id,f.deps)).rejects.toThrow("unknown task");expect(await admissionLeasePresent(ctx,lease)).toBe(false);
});
