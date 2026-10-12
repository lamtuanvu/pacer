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
  const c = fakeCtx(); writeJsonAtomic(latestPath(c), { ...emptySnapshot(), seq: 1 }); let out=await pumpOnce(c,{status:async()=>status(),tasks:()=>[task("done")],publish:async()=>({seq:1,transports:[],errors:[]})}); expect(out.some(e=>e.type==="alert")).toBe(true);
  writeJsonAtomic(latestPath(c), emptySnapshot()); const bad: PumpDeps = { status:async()=>{throw new Error("oops")}, tasks:()=>[], publish:async()=>({seq:1,transports:[],errors:[]}) }; expect((await pumpOnce(c,bad)).length).toBe(1); writeJsonAtomic(latestPath(c), { ...emptySnapshot(), alerts:[{key:"status-error",level:"error",title:"bad",body:"oops",error:"oops",at:1}] }); expect(await pumpOnce(c,bad)).toEqual([]);
});
test("a different status-error message produces a new alert", async () => {
  const c = fakeCtx();
  writeJsonAtomic(latestPath(c), {...emptySnapshot(), alerts:[{key:"status-error",level:"error",title:"pacer status failed",body:"first failure",error:"first failure",at:1}]});
  const published: Envelope[][] = [];
  const out = await pumpOnce(c, {
    status:async()=>{throw new Error("second failure");}, tasks:()=>[],
    publish:async(_ctx,envs)=>{published.push(envs);return {seq:1,transports:[],errors:[]};},
  });
  expect(out).toEqual([{v:1,type:"alert",data:{key:"status-error",level:"error",title:"pacer status failed",body:"second failure",error:"second failure",at:c.now}}]);
  expect(published).toEqual([out]);
});

test("budget publishes pace rounded to one decimal",async()=>{
 const {toBudget}=await import("../src/link/budget");
 const status={generatedAt:1,strategy:"s",planner:"p",mode:"normal",providers:[{id:"p",verdict:"OK",stale:false,binding:{usedPct:30,pace:28.456,resetsAt:100,name:"week"}},{id:"unmetered",verdict:"OK",stale:false,binding:null}],executors:{ranked:[]}} as any;
 expect(toBudget(status).providers.map(p=>p.pacePct)).toEqual([28.5,null]);
});
