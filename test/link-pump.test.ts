import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { pumpOnce, type PumpDeps } from "../src/link/pump";
import { emptySnapshot, type OutboxEvent } from "../src/link/envelope";
import { writeJsonAtomic } from "../src/fsutil";
import { latestPath } from "../src/link/paths";
import { reduce } from "../src/link/envelope";
const status = (mode = "normal") => ({ generatedAt: 1, strategy: "s", planner: "p", mode, disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as any;
const task = (state: string, id = "t") => ({ id, state, brief: { goal: "goal" }, createdAt: 1, attempts: [{ executor: "codex", backend: "orca", startedAt: 2, endedAt: 3 }], result: { executor: "codex", backend: "orca", worktree: null } }) as any;
test("first pump publishes budget and mode without alerts; unchanged input is quiet", async () => {
  const c = fakeCtx(); const sent: OutboxEvent[][] = []; const deps: PumpDeps = { status: async () => status(), tasks: () => [task("running")], publish: async (_c,e) => { sent.push(e); let s = (await import("../src/link/store")).readLatest(c); for (const x of e) s = reduce(s,x,c.now); writeJsonAtomic(latestPath(c),s); return { seq: 1, transports: [], errors: [] }; } };
  expect((await pumpOnce(c,deps)).map(e=>e.type)).toEqual(["budget","mode","task"]); expect((await pumpOnce(c,deps))).toEqual([]); expect(sent).toHaveLength(1);
});
test("mode and task transitions alert with appropriate levels", async () => {
  const c = fakeCtx(); writeJsonAtomic(latestPath(c), { ...emptySnapshot(), seq: 1, budget: { generatedAt: 1, strategy:"s", planner:"p", mode:"normal", providers:[], ranked:[] }, mode: { mode:"normal", previous:null, strategy:"s", at:1 }, tasks:[{ id:"t", state:"running", goal:"goal", executor:null, backend:null, worktree:null, updatedAt:2 }] });
  let current = "emergency"; let state = "done"; const deps: PumpDeps = { status: async()=>status(current), tasks:()=>[task(state)], publish:async(_c,e)=>({seq:2,transports:[],errors:[]}) };
  let out=await pumpOnce(c,deps); expect(out.filter(e=>e.type==="alert").map(e=>(e as any).data.level)).toContain("warn");
  writeJsonAtomic(latestPath(c), { ...emptySnapshot(), seq:1, budget: { generatedAt:1,strategy:"s",planner:"p",mode:"normal",providers:[],ranked:[] }, mode:{mode:"normal",previous:null,strategy:"s",at:1}, tasks:[{id:"t",state:"running",goal:"goal",executor:null,backend:null,worktree:null,updatedAt:2}] });
  out=await pumpOnce(c,{...deps,status:async()=>status("normal"),tasks:()=>[task("failed")]}); expect(out.some(e=>e.type==="task")).toBe(true); expect(out.find(e=>e.type==="alert") as any).toMatchObject({data:{level:"warn"}});
});
test("terminal first seen alerts after initial snapshot and status failures dedupe", async () => {
  const c = fakeCtx(); writeJsonAtomic(latestPath(c), { ...emptySnapshot(), seq: 1 }); let out=await pumpOnce(c,{status:async()=>status(),tasks:()=>[{...task("done"),fromPanel:true}],publish:async()=>({seq:1,transports:[],errors:[]})}); expect(out.some(e=>e.type==="alert")).toBe(true);
  writeJsonAtomic(latestPath(c), emptySnapshot()); const bad: PumpDeps = { status:async()=>{throw new Error("oops")}, tasks:()=>[], publish:async()=>({seq:1,transports:[],errors:[]}) }; expect((await pumpOnce(c,bad)).length).toBe(1); writeJsonAtomic(latestPath(c), { ...emptySnapshot(), alerts:[{key:"status-error",level:"error",title:"bad",body:"oops",error:"oops",at:1}] }); expect(await pumpOnce(c,bad)).toEqual([]);
});
test("a different status-error message produces a new alert", async () => {
  const c = fakeCtx();
  writeJsonAtomic(latestPath(c), {...emptySnapshot(), alerts:[{key:"status-error",level:"error",title:"Status could not be refreshed",body:"first failure",error:"first failure",at:1}]});
  const published: OutboxEvent[][] = [];
  const out = await pumpOnce(c, {
    status:async()=>{throw new Error("second failure");}, tasks:()=>[],
    publish:async(_ctx,envs)=>{published.push(envs);return {seq:1,transports:[],errors:[]};},
  });
  expect(out).toEqual([{type:"alert",data:{key:"status-error",level:"error",title:"Status could not be refreshed",body:"second failure",error:"second failure",at:c.now}}]);
  expect(published).toEqual([out]);
});

test("budget publishes pace rounded to one decimal",async()=>{
 const {toBudget}=await import("../src/link/budget");
 const status={generatedAt:1,strategy:"s",planner:"p",mode:"normal",providers:[{id:"p",verdict:"OK",stale:false,binding:{usedPct:30,pace:28.456,resetsAt:100,name:"week"}},{id:"unmetered",verdict:"OK",stale:false,binding:null}],executors:{ranked:[]}} as any;
 expect(toBudget(status).providers.map(p=>p.pacePct)).toEqual([28.5,null]);
});

test("a finished task that dropped out of the capped snapshot does not re-alert on every pump", async () => {
  const { fakeCtx } = await import("./helpers");
  const { pumpOnce } = await import("../src/link/pump");
  const ctx = fakeCtx();
  const task = { id: "t-20261012-224220-ccfe", state: "failed", createdAt: 1, brief: { goal: "g" }, attempts: [], result: { executor: "agy", backend: "direct" } } as never;
  const published: unknown[][] = [];
  const deps = { status: async () => { throw new Error("skip"); }, tasks: () => [task], publish: async (_c: unknown, envs: unknown[]) => { published.push(envs); return { transports: ["outbox"] } as never; } };
  const realDeps = { ...deps, status: async () => ({ generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", providers: [], executors: { ranked: [] } }) as never };
  await pumpOnce(ctx, realDeps as never);
  await pumpOnce(ctx, realDeps as never);
  await pumpOnce(ctx, realDeps as never);
  const alerts = published.flat().filter((e: any) => e.type === "alert" && e.data.key === "task-t-20261012-224220-ccfe");
  expect(alerts.length).toBeLessThanOrEqual(1);
});

 test("quota alerts ignore UNKNOWN transitions and cool down per provider and verdict",async()=>{
 const c=fakeCtx();let verdict="ON_PACE";
 const st=()=>({...status(),providers:[{id:"claude-code",verdict,stale:false,windows:[],binding:null}]});
 const deps:PumpDeps={status:async()=>st(),tasks:()=>[],publish:async(ctx,envs)=>{let s=(await import("../src/link/store")).readLatest(ctx);for(const e of envs)s=reduce(s,e,ctx.now);writeJsonAtomic(latestPath(ctx),s);return {seq:1,transports:["outbox"],errors:[]};}};
 const quotas=(envs:OutboxEvent[])=>envs.filter(e=>e.type==="alert"&&e.data.notification?.kind==="quota");
 await pumpOnce(c,deps);verdict="NEAR_LIMIT";expect(quotas(await pumpOnce(c,deps))).toHaveLength(1);
 verdict="ON_PACE";await pumpOnce({...c,now:c.now+1},deps);verdict="NEAR_LIMIT";expect(quotas(await pumpOnce({...c,now:c.now+2},deps))).toHaveLength(0);
 verdict="EXHAUSTED";expect(quotas(await pumpOnce({...c,now:c.now+3},deps))).toHaveLength(1);
 verdict="UNKNOWN";expect(quotas(await pumpOnce({...c,now:c.now+1801},deps))).toHaveLength(0);
 verdict="NEAR_LIMIT";expect(quotas(await pumpOnce({...c,now:c.now+1802},deps))).toHaveLength(0);
 verdict="ON_PACE";await pumpOnce({...c,now:c.now+1803},deps);verdict="NEAR_LIMIT";expect(quotas(await pumpOnce({...c,now:c.now+1804},deps))).toHaveLength(1);
 });

 test("broken tasks from one pump remain distinct in the snapshot for executor batching",async()=>{
 const c=fakeCtx();writeJsonAtomic(latestPath(c),{...emptySnapshot(),seq:1});
 const broken=(id:string)=>({...task("failed",id),attempts:[{executor:"agy",brokenReason:"usage error",startedAt:1,endedAt:2}],result:{executor:"agy",brokenExecutor:"agy",brokenReason:"usage error"}});
 await pumpOnce(c,{status:async()=>status(),tasks:()=>[broken("one"),broken("two")],publish:async(ctx,envs)=>{let s=(await import("../src/link/store")).readLatest(ctx);for(const e of envs)s=reduce(s,e,ctx.now);writeJsonAtomic(latestPath(ctx),s);return{seq:1,transports:["outbox"],errors:[]};}});
 const snap=(await import("../src/link/store")).readLatest(c);
 expect(snap.alerts.filter(a=>a.notification?.kind==="broken")).toHaveLength(2);
 const {notifyNewAlerts}=await import("../orca-plugin/src/notify");const {readSettings}=await import("../orca-plugin/src/settings");const notes:any[]=[];
 const host={call:async(method:string,params:any)=>{if(method==="notifications.show"){notes.push(params);return{delivered:true};}return{ok:true};}} as any;
 await notifyNewAlerts(host,snap,readSettings({notifications:"important"},c.home),c.now,c.now+31);
 expect(notes).toHaveLength(1);expect(notes[0].body).toContain("2 tasks affected");
 });

test("resolved placement changes publish once while unchanged objects stay quiet",async()=>{
 const ctx=fakeCtx();let why="strategy default";
 const deps:PumpDeps={status:async()=>status(),tasks:()=>[{...task("running"),placement:{requested:"new",mode:"new",why},worktree:"/isolated"}],publish:async(c,events)=>{let s=(await import("../src/link/store")).readLatest(c);for(const e of events)s=reduce(s,e,c.now);writeJsonAtomic(latestPath(c),s);return{seq:s.seq,transports:["outbox"],errors:[]};}};
 expect((await pumpOnce(ctx,deps)).find(e=>e.type==="task")).toMatchObject({data:{placement:{mode:"new",why},worktree:"/isolated"}});
 expect(await pumpOnce(ctx,deps)).toEqual([]);
 why="agent: exploratory";expect((await pumpOnce(ctx,deps)).filter(e=>e.type==="task")).toHaveLength(1);
 expect(await pumpOnce(ctx,deps)).toEqual([]);
});

test("entityDiff publishes changed rows and tombstones only",async()=>{
 const {entityDiff}=await import("../src/link/pump");
 const rows=["a","b"].map(id=>({kind:"executor" as const,id,value:{id}}));
 const first=entityDiff({},rows);expect(first.envelopes).toHaveLength(2);
 expect(entityDiff(first.next,rows).envelopes).toHaveLength(0);
 expect(entityDiff(first.next,rows.slice(0,1)).envelopes).toEqual([{type:"entity",data:{kind:"executor",id:"b",removed:true}}]);
});
test("pump persists entity changes only after outbox success, never sends them to channel",async()=>{
 const {capacityFixture}=await import("./read-model-helpers");
 const {publish}=await import("../src/link/publish");
 const {eventsSince}=await import("../src/api/events");
 const {s,st}=capacityFixture(),ctx=fakeCtx();
 let success=true,backfilled:string[]=[];
 const deps:PumpDeps={status:async()=>st,tasks:()=>[],strategy:()=>s,backfillRepos:async(_c,paths)=>{backfilled=paths;},setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:async(c,envs)=>{
  return success?publish(c,envs):{seq:0,transports:[],errors:["disk full"]};
 }};
 await pumpOnce(ctx,deps);const before=eventsSince(ctx,0).last;
 st.providers.find(p=>p.id==="codex")!.brokenReason="not working";
 success=false;await pumpOnce({...ctx,now:ctx.now+1},deps);
 success=true;const changed=await pumpOnce({...ctx,now:ctx.now+2},deps);
 expect(changed.filter(e=>e.type==="entity"&&e.data.kind==="executor")).toHaveLength(1);
 expect(eventsSince(ctx,before).events.find(e=>e.type==="executor")?.data).toMatchObject({state:"down"});
 expect(backfilled).toEqual([]);
 expect((await pumpOnce({...ctx,now:ctx.now+3},deps)).filter(e=>e.type==="entity")).toHaveLength(0);
});

test("counts and progress coalesce, while state transitions are immediate",async()=>{
 const {capacityFixture}=await import("./read-model-helpers");
 const {publish}=await import("../src/link/publish");
 const {s,st}=capacityFixture(),ctx=fakeCtx(),record={...task("running"),brief:{goal:"g",repo:"/missing/api"},executor:"codex",progress:{phase:"working",lastOutputAt:ctx.now,files:0,commits:0,logBytes:0}};
 const paths:string[][]=[];
 const deps:PumpDeps={status:async()=>st,tasks:()=>[record],strategy:()=>s,setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),backfillRepos:async(_c,p)=>{paths.push(p);},publish:(c,e)=>publish(c,e)};
 await pumpOnce(ctx,deps);
 record.progress.files=1;
 expect((await pumpOnce({...ctx,now:ctx.now+0.2},deps)).filter(e=>e.type==="task")).toHaveLength(0);
 record.state="done";
 const transition=await pumpOnce({...ctx,now:ctx.now+0.4},deps);
 expect(transition.filter(e=>e.type==="task")).toHaveLength(1);
 expect(transition.filter(e=>e.type==="entity"&&e.data.kind==="counts")).toHaveLength(0);
 const later=await pumpOnce({...ctx,now:ctx.now+1},deps);
 expect(later.filter(e=>e.type==="entity"&&e.data.kind==="counts")).toHaveLength(1);
 expect(paths[0]).toEqual(["/missing/api"]);
});

test("running tasks beyond the legacy 20-row cache still stream progress",async()=>{
 const {publish}=await import("../src/link/publish");const ctx=fakeCtx();
 const tasks=Array.from({length:21},(_,i)=>({...task("running",`t${i}`),createdAt:ctx.now-i,attempts:[],progress:{phase:"working",lastOutputAt:ctx.now,files:0,commits:0,logBytes:0}}));
 const deps:PumpDeps={status:async()=>status(),tasks:()=>tasks,publish:(c,e)=>publish(c,e)};
 await pumpOnce(ctx,deps);tasks[20]!.progress.files=1;
 const out=await pumpOnce({...ctx,now:ctx.now+1},deps);
 expect(out.filter(e=>e.type==="task")).toHaveLength(1);
 expect(out.find(e=>e.type==="task")).toMatchObject({data:{id:"t20",progress:{files:1}}});
});

test("pump publishes entity events without creating plugin storage",async()=>{
 const {capacityFixture}=await import("./read-model-helpers");
 const {publish}=await import("../src/link/publish");
 const {pluginDataDir}=await import("../src/link/paths");
 const {existsSync}=await import("node:fs");
 const {join}=await import("node:path");
 const {eventsSince}=await import("../src/api/events");
 const {s,st}=capacityFixture(),ctx=fakeCtx();
 await pumpOnce(ctx,{status:async()=>st,tasks:()=>[],strategy:()=>s,setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish});
 expect(existsSync(join(pluginDataDir(ctx),"storage.json"))).toBe(false);
 expect(eventsSince(ctx,0).events.some(e=>e.type==="executor")).toBe(true);
});

test("terminal receipt changes publish immediately alongside entity events",async()=>{
 const {capacityFixture}=await import("./read-model-helpers");
 const {publish}=await import("../src/link/publish");
 const {updateOrcaState}=await import("../src/exec/orca/state");
 const {s,st}=capacityFixture(),ctx=fakeCtx();let connected=true;
 const record={...task("running"),brief:{goal:"g",repo:ctx.home},attempts:[]};
 updateOrcaState(ctx,state=>{state.workers.d={dispatchId:"d",taskId:record.id,terminal:"term_worker",executor:"codex",worktree:null,startedAt:ctx.now};});
 ctx.run=async argv=>argv[0]==="orca"&&argv[1]==="terminal"
  ? {code:0,stdout:JSON.stringify({ok:true,result:{terminal:{handle:"term_worker",connected,writable:true}}}),stderr:""}
  : {code:1,stdout:"",stderr:"offline"};
 const deps:PumpDeps={status:async()=>st,tasks:()=>[record],strategy:()=>s,setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:(c,envs)=>publish(c,envs)};
 const first=await pumpOnce(ctx,deps);
 expect(first.find(e=>e.type==="task")).toMatchObject({data:{terminalPresent:true}});
 expect(first.some(e=>e.type==="entity")).toBe(true);
 connected=false;
 expect((await pumpOnce(ctx,deps)).find(e=>e.type==="task")).toMatchObject({data:{terminalPresent:false}});
 expect((await pumpOnce(ctx,deps)).filter(e=>e.type==="task")).toHaveLength(0);
});

test("a failed task publishes attention and counts, then clears attention on retry",async()=>{
 const {capacityFixture}=await import("./read-model-helpers");
 const {publish}=await import("../src/link/publish");
 const {s,st}=capacityFixture(),ctx=fakeCtx(),record={...task("running"),createdAt:ctx.now,brief:{goal:"g",repo:ctx.home},attempts:[]};
 const deps:PumpDeps={status:async()=>st,tasks:()=>[record],strategy:()=>s,setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:(c,e)=>publish(c,e)};
 await pumpOnce(ctx,deps);record.state="failed";
 const out=await pumpOnce({...ctx,now:ctx.now+1},deps);
 expect(out.filter(e=>e.type==="entity"&&e.data.kind==="attention")).toMatchObject([{data:{id:`failed:${record.id}`,value:{kind:"failed"}}}]);
 expect(out.find(e=>e.type==="entity"&&e.data.kind==="counts")).toMatchObject({data:{value:{attention:1,problems:1}}});
 Object.assign(record,{retriedBy:"next"});
 expect((await pumpOnce({...ctx,now:ctx.now+2},deps)).find(e=>e.type==="entity"&&e.data.kind==="attention")).toMatchObject({data:{id:`failed:${record.id}`,removed:true}});
});

test("pump dispatches attention notifications once to the active notifier",async()=>{
 const {capacityFixture}=await import("./read-model-helpers"),{publish}=await import("../src/link/publish"),{register}=await import("../src/clients/registry");
 const {s,st}=capacityFixture(),ctx=fakeCtx();register(ctx,{kind:"orca",version:"1",notifier:true});
 const record={...task("failed"),createdAt:ctx.now,brief:{goal:"failed goal",repo:ctx.home},attempts:[]};
 const deps:PumpDeps={status:async()=>st,tasks:()=>[record],strategy:()=>s,setup:async()=>({checkedAt:ctx.now,complete:true,items:[]}),publish:(c,envs)=>publish(c,envs)};
 expect((await pumpOnce(ctx,deps)).filter(e=>e.type==="entity"&&e.data.kind==="notify")).toHaveLength(1);
 expect((await pumpOnce(ctx,deps)).filter(e=>e.type==="entity"&&e.data.kind==="notify")).toHaveLength(0);
});
