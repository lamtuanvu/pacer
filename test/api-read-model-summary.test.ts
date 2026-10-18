import { expect, test } from "bun:test";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx, localTs, realRun, tmpDir } from "./helpers";
import { record } from "./read-model-helpers";
import { apiTask } from "../src/api/read-model/tasks";
import { liveSnapshot } from "../src/api/events";
import { emptySnapshot } from "../src/link/envelope";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

test("counts split by repo, today uses local midnight and setup counts required open items",()=>{
 const ctx=fakeCtx({now:localTs(2026,10,16,0,30)}),{st,s}=capacityFixture();
 const tasks=[record("running",ctx.now),record("running",ctx.now+1),record("queued",ctx.now+2),record("done",ctx.now+3),record("done",ctx.now+4),record("done",localTs(2026,10,16,0,10),{review:{accepted:true,kind:null,note:null,at:ctx.now}}),record("done",localTs(2026,10,15,23,50)),record("failed",ctx.now,{review:{accepted:false,kind:null,note:null,at:ctx.now}})].map((t,i)=>apiTask(ctx,{...t,repo:{key:i%2?"b":"a",label:"repo",path:"/repo"}}));
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks,hosts:Object.values(s.hosts),setup:{checkedAt:ctx.now,complete:false,items:[{id:"required",title:"Required",status:"pending",required:true},{id:"optional",title:"Optional",status:"pending",required:false}]}});
 expect(model.counts).toMatchObject({running:2,queued:1,review:3,setupOpen:1,byRepo:{a:{running:1,review:2},b:{running:1,review:1}}});
 expect(model.today).toMatchObject({since:localTs(2026,10,16),done:4,accepted:1,rejected:1,failed:1});
 expect(model.hosts[0]).toMatchObject({state:"ready",maxTasks:3});
});
test("live snapshot adds fields and preserves every old key",async()=>{
 const ctx=fakeCtx(),{st}=capacityFixture();mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 const {snapshot}=await liveSnapshot(ctx,{status:async()=>st});
 for(const key of Object.keys(emptySnapshot()))expect(snapshot).toHaveProperty(key);
 expect(snapshot).toHaveProperty("budget");expect(snapshot).toHaveProperty("planner");expect(snapshot).toHaveProperty("counts");
});

test("unconfigured and unavailable services still provide a read model",async()=>{
 const ctx=fakeCtx();
 const unconfigured=await liveSnapshot(ctx,{status:async()=>{throw Error("unavailable");}});
 expect(unconfigured.snapshot.planner).toBeNull();
 expect(unconfigured.snapshot.counts.running).toBe(0);
 expect(unconfigured.snapshot.setup.open).toBeGreaterThan(0);
});

test("new fields never expose account credentials, emails or endpoint configuration",()=>{
 const ctx=fakeCtx(),{st,s}=capacityFixture(),account=Object.values(s.accounts)[0]!;
 account.orcaAccount="person@example.test";account.home="/private/account-home";
 account.connection={api:"openai-compatible",base_url:"https://secret.example.test/private",key:"env:PRIVATE_KEY",models:[]};
 s.hosts.devbox!.accounts.private={home:"/home/person@example.test"};
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks:[],hosts:Object.values(s.hosts),setup:{checkedAt:ctx.now,complete:true,items:[]}});
 const json=JSON.stringify(model);
 for(const secret of ["person@example.test","PRIVATE_KEY","secret.example.test","/private/account-home"])expect(json).not.toContain(secret);
});

test("snapshot uses current supplied status for capacity even when the old budget is fresh",async()=>{
 const ctx=fakeCtx(),{st}=capacityFixture();mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 await liveSnapshot(ctx,{status:async()=>st});
 const down={...st,providers:st.providers.map(p=>p.id==="codex"?{...p,brokenReason:"down"}:p)};
 const {snapshot}=await liveSnapshot({...ctx,now:ctx.now+1},{status:async()=>down});
 expect(snapshot.executors.find(e=>e.id==="codex")!.state).toBe("down");
});

test("attention counts include severity and repo totals and snapshot exposes items",async()=>{
 const ctx=fakeCtx(),{st,s}=capacityFixture();
 const tasks=[record("done",ctx.now-1000),record("failed",ctx.now-1001),record("running",ctx.now-1002,{progress:{phase:"idle",lastOutputAt:ctx.now-1000,lastChangeAt:ctx.now-1000,host:"local",updatedAt:ctx.now,files:0,commits:0,logBytes:0}})].map(t=>apiTask(ctx,t));
 const setup={checkedAt:ctx.now,complete:true,items:[]};
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks,hosts:[],setup});
 expect(model.counts).toMatchObject({attention:3,problems:2,byRepo:{[tasks[0]!.repo.key]:{attention:3}}});
 expect(model.attention.map(i=>i.kind)).toEqual(["stuck","failed","review"]);
 const {snapshot}=await liveSnapshot(ctx,{status:async()=>st});
 expect(snapshot.attention).toBeArray();
});

test("planner task source survives mapping so the review grace applies",()=>{
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 const t=apiTask(ctx,record("done",ctx.now-599,{source:"planner"}));
 expect(t.source).toBe("planner");
 expect(buildReadModel(ctx,{status:st,strategy:s,tasks:[t],hosts:[],setup:{checkedAt:ctx.now,complete:true,items:[]}}).attention).toEqual([]);
});

test("snapshot wires pause, hold, auth failure, readiness and disabled rows",async()=>{
 const {writeJsonAtomic}=await import("../src/fsutil"),{startJob,registerJobDaemon}=await import("../src/jobs/registry");
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 writeJsonAtomic(join(ctx.pacerHome,"state/pause.json"),{until:ctx.now+60,reason:"break",by:null});
 writeJsonAtomic(join(ctx.pacerHome,"state/auth-failed.json"),{[s.runners.codex!.account]:ctx.now});
 writeJsonAtomic(join(ctx.pacerHome,"state/runner-checks.json"),{codex:{at:ctx.now,passed:false,detail:"failed sk-private-test-token person@example.test"}});
 st.modeHold={mode:"normal",until:ctx.now+60};
 const model=()=>buildReadModel(ctx,{status:st,strategy:s,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,items:[]}});
 expect(model()).toMatchObject({pause:{until:ctx.now+60},planner:{modeHeldUntil:ctx.now+60}});
 expect(model().accounts.find(a=>a.name===s.runners.codex!.account)?.signedIn).toBe(false);
 expect(model().executors.find(e=>e.id==="codex")).toMatchObject({state:"failing",lastCheck:{passed:false}});
 expect(model().attention.some(a=>a.id==="executor_down:codex")).toBe(true);
 expect(JSON.stringify(model())).not.toContain("sk-private-test-token");
 const unregister=registerJobDaemon(ctx);let release!:()=>void;
 try{
  await startJob(ctx,"runner.check","codex",[],async()=>{await new Promise<void>(r=>release=r);});
  expect(model().executors.find(e=>e.id==="codex")?.state).toBe("checking");
  s.runners.codex!.enabled=false;
  expect(model().executors.find(e=>e.id==="codex")).toMatchObject({state:"disabled",enabled:false});
 }finally{release();unregister();}
});

test("pause and resume activity and snapshot pause fields are safe",async()=>{
 const {callOp}=await import("../src/api/ops"),{readActivity}=await import("../src/activity/log");
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 await callOp(ctx,"delegation.pause",{for:"1h",reason:"sk-private-test-token person@example.test"});
 const input={strategy:s,status:st,tasks:[],hosts:[],setup:{complete:true,checkedAt:ctx.now,items:[]}};
 const model=buildReadModel(ctx,input);
 expect(JSON.stringify(model.pause)).not.toContain("sk-private-test-token");
 expect(JSON.stringify(model.pause)).not.toContain("person@example.test");
 await callOp(ctx,"delegation.resume",{});
 expect(buildReadModel(ctx,input).pause).toBeNull();
 expect(readActivity(ctx).entries.map(e=>e.text).filter(t=>t.startsWith("Delegation"))).toEqual(["Delegation resumed","Delegation paused for 1h"]);
});

test("a fresh mode hold and its expiry invalidate the snapshot status cache",async()=>{
 const {writeJsonAtomic}=await import("../src/fsutil");const ctx=fakeCtx();
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 expect((await liveSnapshot(ctx)).snapshot.planner?.mode).toBe("normal");
 writeJsonAtomic(join(ctx.pacerHome,"state/mode-hold.json"),{mode:"emergency",until:ctx.now+30});
 expect((await liveSnapshot(ctx)).snapshot.planner).toMatchObject({mode:"emergency",modeHeldUntil:ctx.now+30});
 const expired=(await liveSnapshot({...ctx,now:ctx.now+30})).snapshot.planner!;
 expect(expired.mode).toBe("normal");expect(expired.modeHeldUntil).toBeUndefined();
});


test("snapshot repos omit dead registrations but retain missing repos with window tasks",async()=>{
 const {resolveRepo}=await import("../src/core/repos");
 const ctx=fakeCtx({run:realRun}),{st,s}=capacityFixture();
 const dead=tmpDir(),running=tmpDir(),recent=tmpDir();
 for(const path of [dead,running,recent])Bun.spawnSync(["git","init","-q",path]);
 const deadRef=await resolveRepo(ctx,dead),runningRef=await resolveRepo(ctx,running),recentRef=await resolveRepo(ctx,recent);
 for(const path of [dead,running,recent])rmSync(path,{recursive:true});
 const tasks=[record("done",ctx.now-86401,{repo:deadRef}),record("running",ctx.now-86401,{repo:runningRef}),record("done",ctx.now-60,{repo:recentRef})].map(t=>apiTask(ctx,t));
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks,hosts:[],setup:{checkedAt:ctx.now,complete:true,items:[]}});
 expect(model.repos.map(r=>r.key).sort()).toEqual([runningRef.key,recentRef.key].sort());
 const registry=await Bun.file(join(ctx.pacerHome,"state","repos.json")).json();
 expect(Object.values(registry).map((entry:any)=>entry.key).sort()).toEqual([runningRef.key,recentRef.key].sort());
});
