import { expect, test } from "bun:test";
import { probeHosts } from "../src/remote/eligibility";
import { buildReadModel } from "../src/api/read-model";
import { capacityFixture, record } from "./read-model-helpers";
import { apiTask } from "../src/api/read-model/tasks";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { pumpOnce } from "../src/link/pump";

test("host probe requires two failures, clears on success and leaves running tasks intact",async()=>{
 const ctx=fakeCtx(),{s,st}=capacityFixture();
 const t=createTask(ctx,{brief:{goal:"work",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,t.id,t=>{t.state="running";t.executor="codex@devbox";});
 const before=readTask(ctx,t.id);
 const tasks=[{...apiTask(ctx,record("running",ctx.now,{executor:"codex@devbox"})),host:"devbox"}];
 const model=()=>buildReadModel(ctx,{strategy:s,status:st,tasks,hosts:Object.values(s.hosts),setup:{complete:true,checkedAt:ctx.now,ready:false,items:[]}});
 const probe=(ok:boolean)=>probeHosts(ctx,{strategy:()=>s,reachable:async()=>ok});
 expect(await probe(false)).toEqual([{alias:"devbox",reachable:false,failures:1}]);
 expect(model().attention.filter(a=>a.kind==="host_down")).toEqual([]);
 expect(await probe(false)).toEqual([{alias:"devbox",reachable:false,failures:2}]);
 expect(model().hosts[0]?.state).toBe("down");
 expect(model().counts.hostsWithProblems).toBe(1);
 expect(model().attention.find(a=>a.kind==="host_down")).toMatchObject({id:"host_down:devbox",detail:"1 task(s) running there. New work goes to Codex until it is back.",actions:[{op:"host.check",params:{alias:"devbox"}},{op:"host.set",params:{alias:"devbox",paused:true}}]});
 expect(await probe(true)).toEqual([{alias:"devbox",reachable:true,failures:0}]);
 expect(model().hosts[0]?.state).toBe("ready");
 expect(model().attention.filter(a=>a.kind==="host_down")).toEqual([]);
 expect(readTask(ctx,t.id)).toEqual(before);
 await probe(false);await probe(false);
 s.runners["codex@devbox"]!.enabled=false;
 expect(await probe(false)).toEqual([]);
 expect(model().attention.some(a=>a.kind==="host_down")).toBe(false);
});

test("pump probes hosts every 300 seconds",async()=>{
 const ctx=fakeCtx(),{s,st}=capacityFixture();let probes=0;
 const deps={status:async()=>st,strategy:()=>s,tasks:()=>[],setup:async()=>({complete:true,checkedAt:ctx.now,ready:false,items:[]}),publish:async()=>({seq:0,transports:[] as [],errors:[]}),probeHosts:async()=>{probes++;return [];}};
 await pumpOnce(ctx,deps);await pumpOnce({...ctx,now:ctx.now+299},deps);
 expect(probes).toBe(1);
 await pumpOnce({...ctx,now:ctx.now+300},deps);expect(probes).toBe(2);
});

test("pump logs an expired mode hold once",async()=>{
 const {writeJsonAtomic}=await import("../src/fsutil"),{readActivity}=await import("../src/activity/log");
 const ctx=fakeCtx(),{s,st}=capacityFixture();st.mode="strict";
 writeJsonAtomic(`${ctx.pacerHome}/state/mode-hold.json`,{mode:"normal",until:ctx.now});
 const deps={status:async()=>st,strategy:()=>s,tasks:()=>[],setup:async()=>({complete:true,checkedAt:ctx.now,ready:false,items:[]}),publish:async()=>({seq:0,transports:[] as [],errors:[]}),probeHosts:async()=>[]};
 await pumpOnce(ctx,deps);await pumpOnce({...ctx,now:ctx.now+1},deps);
 expect(readActivity(ctx).entries.filter(e=>e.text==="Mode hold ended · back to Strict")).toHaveLength(1);
});
