import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { pumpOnce, type PumpDeps } from "../src/link/pump";
import { emptySnapshot, type Envelope } from "../src/link/envelope";
import { writeJsonAtomic } from "../src/fsutil";
import { latestPath } from "../src/link/paths";
import { reduce } from "../src/link/envelope";
const status = (mode = "normal") => ({ generatedAt: 1, strategy: "s", planner: "p", mode, disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as any;
const task = (state: string, id = "t") => ({ id, state, brief: { goal: "goal" }, createdAt: 1, attempts: [{ executor: "codex", backend: "orca", startedAt: 2, endedAt: 3 }], result: { executor: "codex", backend: "orca", worktree: null } }) as any;
test("first pump publishes budget and mode without alerts; unchanged input is quiet", async () => {
  const c = fakeCtx(); const sent: Envelope[][] = []; const deps: PumpDeps = { status: async () => status(), tasks: () => [task("running")], publish: async (_c,e) => { sent.push(e); let s = (await import("../src/link/store")).readLatest(c); for (const x of e) s = reduce(s,x,c.now); writeJsonAtomic(latestPath(c),s); return { seq: 1, transports: [], errors: [] }; } };
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
  const published: Envelope[][] = [];
  const out = await pumpOnce(c, {
    status:async()=>{throw new Error("second failure");}, tasks:()=>[],
    publish:async(_ctx,envs)=>{published.push(envs);return {seq:1,transports:[],errors:[]};},
  });
  expect(out).toEqual([{v:1,type:"alert",data:{key:"status-error",level:"error",title:"Status could not be refreshed",body:"second failure",error:"second failure",at:c.now}}]);
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
 const quotas=(envs:Envelope[])=>envs.filter(e=>e.type==="alert"&&e.data.notification?.kind==="quota");
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
