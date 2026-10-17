import { expect, test } from "bun:test";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx, localTs } from "./helpers";
import { record } from "./read-model-helpers";
import { apiTask } from "../src/api/read-model/tasks";
import { liveSnapshot } from "../src/api/events";
import { emptySnapshot } from "../src/link/envelope";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

test("counts split by repo, today uses local midnight and setup counts required open items",()=>{
 const ctx=fakeCtx({now:localTs(2026,10,16,0,30)}),{st,s}=capacityFixture();
 const tasks=[record("running",ctx.now),record("running",ctx.now+1),record("queued",ctx.now+2),record("done",ctx.now+3),record("done",ctx.now+4),record("done",localTs(2026,10,16,0,10),{review:{accepted:true,kind:null,note:null,at:ctx.now}}),record("done",localTs(2026,10,15,23,50)),record("failed",ctx.now,{review:{accepted:false,kind:null,note:null,at:ctx.now}})].map((t,i)=>apiTask(ctx,{...t,repo:{key:i%2?"b":"a",label:"repo",path:"/repo"}}));
 const model=buildReadModel(ctx,{status:st,strategy:s,tasks,hosts:Object.values(s.hosts),setup:{checkedAt:ctx.now,complete:false,items:[{id:"required",title:"Required",status:"pending",required:true},{id:"optional",title:"Optional",status:"pending",required:false}]}});
 expect(model.counts).toMatchObject({running:2,queued:1,review:3,setupOpen:1,byRepo:{a:{running:1,review:2},b:{running:1,review:1}}});
 expect(model.today).toMatchObject({since:localTs(2026,10,16),done:4,accepted:1,rejected:1,failed:1});
 expect(model.hosts[0]).toMatchObject({state:"unknown",maxTasks:3});
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
