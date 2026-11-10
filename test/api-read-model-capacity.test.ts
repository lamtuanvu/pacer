import { setMachineReaders } from "../src/engine/machine";
import { expect, test } from "bun:test";
import { buildExecutors, buildPlanner, buildAccounts } from "../src/api/read-model/capacity";
import type { ApiTask } from "../src/api/read-model/types";
import { capacityFixture } from "./read-model-helpers";

test("planner first, remote slots, shared places and exactly one next",()=>{
 const {s,st}=capacityFixture(), rows=buildExecutors(st,s,[],100000);
 expect(rows[0]!.rank).toBe("planner");
 expect(rows.find(r=>r.id==="codex@devbox")).toMatchObject({host:"devbox",slots:{used:0,max:3}});
 for(const r of rows.filter(r=>r.agent==="codex"))expect(r.sub.endsWith("this Mac + devbox")).toBe(true);
 expect(rows.filter(r=>r.next).map(r=>r.id)).toEqual(["codex"]);
 expect(buildAccounts(st,s).some(a=>a.executors.includes("codex@devbox"))).toBe(true);
});
test("blocked and broken take precedence over failures and capacity",()=>{
 const {s,st}=capacityFixture();st.providers.find(p=>p.id==="codex")!.brokenReason="broken";
 st.providers.find(p=>p.id==="cursor")!.blockedReason="blocked";
 const tasks=[1,2].map(i=>({id:String(i),executor:Object.values(s.runners).find(r=>r.agent==="opencode")!.id,state:"failed",updatedAt:99999}) as ApiTask);
 const rows=buildExecutors(st,s,tasks,100000);
 expect(rows.find(r=>r.id==="codex")).toMatchObject({state:"down",tone:"bad"});
 expect(rows.find(r=>r.id==="cursor")!.state).toBe("blocked");
 expect(rows.find(r=>r.agent==="opencode")!.state).toBe("failing");
});
for(const planner of ["claude-code","codex","cursor","opencode"])test(`planner meter is agnostic: ${planner}`,()=>{
 const {st}=capacityFixture(planner);
 expect(buildPlanner(st)).toMatchObject({verdict:"behind",deltaPts:-14,advice:"14 pts under pace — spend it."});
 st.providers.find(p=>p.id===planner)!.binding=null;
 expect(buildPlanner(st)).toMatchObject({verdict:"unknown",usedPct:null,pacePct:null,deltaPts:null,advice:"No usage reading for the planner yet."});
});

test("UNKNOWN planner with a binding hides all usage numbers",()=>{
 const {st}=capacityFixture();st.providers.find(p=>p.id===st.planner)!.verdict="UNKNOWN";
 expect(buildPlanner(st)).toMatchObject({verdict:"unknown",usedPct:null,pacePct:null,deltaPts:null,activeHoursLeft:null,resetsAt:null,window:null,advice:"No usage reading for the planner yet."});
});

test("capacity reasons redact credential-shaped diagnostics and email addresses",()=>{
 const {s,st}=capacityFixture();
 st.providers.find(p=>p.id==="codex")!.brokenReason="sign in person@example.test with sk-private-test-token";
 const row=buildExecutors(st,s,[],st.generatedAt).find(r=>r.id==="codex")!;
 expect(row.state).toBe("down");
 for(const secret of ["person@example.test","sk-private-test-token"])expect(JSON.stringify(row)).not.toContain(secret);
});

test("configured executor slots and shared machine and host limits",()=>{
 const {s,st}=capacityFixture();s.runners.codex!.maxTasks=3;s.execution={...s.execution,local_max_tasks:4};
 const tasks=[1,2].map(i=>({id:String(i),executor:"codex",state:"running",host:null}) as ApiTask);
 expect(buildExecutors(st,s,tasks,st.generatedAt).find(e=>e.id==="codex")).toMatchObject({state:"busy",slots:{used:2,max:3}});
 s.execution.local_max_tasks=2;
 expect(buildExecutors(st,s,tasks,st.generatedAt).find(e=>e.id==="codex")).toMatchObject({state:"full",reason:"this machine busy (2/2)"});
 s.runners["codex@devbox"]!.maxTasks=4;
 const remote=[1,2,3].map(i=>({id:String(i),executor:"codex@devbox",state:"running",host:"devbox"}) as ApiTask);
 expect(buildExecutors(st,s,remote,st.generatedAt).find(e=>e.host==="devbox")).toMatchObject({state:"full",reason:"devbox busy (3/3)",slots:{used:3,max:4}});
});

test("executor shared-cap notes appear only below the configured executor limit", () => {
 const {s,st}=capacityFixture();
 s.runners.codex!.maxTasks=4;
 s.runners['codex@devbox']!.maxTasks=4;
 let rows=buildExecutors(st,s,[],st.generatedAt);
 // No fixed machine cap by default: nothing is lower than the executor's own limit.
 expect(rows.find(e=>e.id==='codex')?.limitedBy).toBeUndefined();
 s.execution.local_max_tasks=2;
 rows=buildExecutors(st,s,[],st.generatedAt);
 expect(rows.find(e=>e.id==='codex')).toMatchObject({limitedBy:'machine',slots:{max:4}});
 expect(rows.find(e=>e.id==='codex@devbox')).toMatchObject({limitedBy:'host',slots:{max:4}});
 s.execution.local_max_tasks=4;s.hosts.devbox!.maxTasks=4;
 rows=buildExecutors(st,s,[],st.generatedAt);
 expect(rows.find(e=>e.id==='codex')?.limitedBy).toBeUndefined();
 expect(rows.find(e=>e.id==='codex@devbox')?.limitedBy).toBeUndefined();
});

test('executor table follows saved priority rather than routing declaration order', () => {
 const {s,st}=capacityFixture();
 s.pacing.order=['cursor','codex'];
 const rows=buildExecutors(st,s,[],st.generatedAt).filter(r=>r.rank!=='planner');
 expect(rows.slice(0,2).map(r=>r.id)).toEqual(['cursor','codex']);
});

test("executor rows show hard caps only; the machine row carries the guard",()=>{
 const {s,st}=capacityFixture();
 setMachineReaders({pressure:()=>4,load:()=>({avg1:0,cores:1})});
 try{
  const rows=buildExecutors(st,s,[],st.generatedAt);
  expect(rows.find(e=>e.id==="codex")?.state).not.toBe("full");
  expect(rows.find(e=>e.id==="codex")?.reason ?? "").not.toContain("memory pressure");
 }finally{setMachineReaders({pressure:()=>1,load:()=>({avg1:0,cores:1})});}
});

test("indexed retry capacity matches full API history, including timestamp and executor precedence", async () => {
 const {fakeCtx,tmpDir}=await import("./helpers");
 const {createTask,taskDatabase,capacityTaskRecords,listTasks}=await import("../src/tasks/store");
 const {apiTasks}=await import("../src/api/read-model/tasks");
 const {taskData}=await import("../src/link/pump");
 const {s,st}=capacityFixture(),ctx=fakeCtx({now:200000}),repo=tmpDir();
 const base=createTask(ctx,{brief:{repo,goal:"capacity semantics"},kind:null,requestedExecutor:null,timeoutS:60});
 const db=taskDatabase(ctx),cutoff=ctx.now-86400;
 const cases: Record<string,unknown>[]=[
  {state:"running",executor:"codex"},
  {state:"running",executor:"codex@devbox",run:{host:"devbox"}},
  {state:"running",executor:"cursor",question:{at:ctx.now,text:"waiting"}},
  {state:"running",executor:"cursor",question:{at:ctx.now,text:"answered",answer:null}},
  {state:"running",executor:"codex",archived:true},
  {state:"failed",executor:"codex",createdAt:cutoff,dismissed:true},
  {state:"failed",executor:"cursor",result:{executor:"codex"},createdAt:cutoff},
  {state:"failed",executor:"codex",createdAt:cutoff-1},
  {state:"failed",executor:"codex",createdAt:cutoff,archived:true},
  {state:"failed",executor:null,attempts:[{executor:"cursor",startedAt:cutoff,endedAt:cutoff}]},
  {state:"failed",executor:"",requestedExecutor:"codex",createdAt:cutoff},
  {state:"failed",requestedExecutor:"codex",createdAt:cutoff},
  {state:"done",executor:"codex",createdAt:ctx.now},
  // A review/write timestamp alone must not make an old failure recent.
  {state:"failed",executor:"codex",review:{at:ctx.now}},
  ...["attemptStartedAt","reviewRequest","stopPending","question"].map(field=>({
   state:"failed",executor:"cursor",[field]:field==="attemptStartedAt"?cutoff:
    field==="stopPending"?{requestedAt:cutoff}:field==="question"?{at:1,answeredAt:cutoff}:{at:cutoff},
  })),
 ];
 const insert=db.query("INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES(?,1,?,?,?,?,?)");
 for(const [i,fields] of cases.entries()){
  const record={...base,id:`case-${i}`,createdAt:1,...fields};
  insert.run(record.id,record.state,record.createdAt,ctx.now,JSON.stringify(record),record.archived?1:0);
 }
 const full=buildExecutors(st,s,apiTasks(ctx,listTasks(ctx,Infinity)),ctx.now);
 const selected=capacityTaskRecords(ctx);
 const rows=buildExecutors(st,s,selected.map(t=>({...taskData(t),host:t.run?.host??null})),ctx.now);
 expect(rows).toEqual(full);
 expect(rows.find(r=>r.id==="codex")).toMatchObject({recentFailures:2,state:"failing",slots:{used:1}});
 expect(rows.find(r=>r.id==="cursor")).toMatchObject({recentFailures:5,slots:{used:1}});
 expect(selected.some(t=>t.id==="case-7"||t.id==="case-13")).toBe(false);
});
