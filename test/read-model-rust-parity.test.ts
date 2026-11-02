import { afterAll, expect, test } from "bun:test";
import { buildAccounts, buildExecutors, buildPlanner } from "../src/api/read-model/capacity";
import { apiTasks } from "../src/api/read-model/tasks";
import { writeJsonAtomic } from "../src/fsutil";
import { join } from "node:path";
import { capacityFixture, record } from "./read-model-helpers";

import { rustRequest, closeRustProbe, readModelCtx as fakeCtx } from "./read-model-rust-helpers";
import type { ApiTask } from "../src/api/read-model/types";

afterAll(closeRustProbe);

test("Rust capacity matches TS for priority, failure precedence, shared caps, checks, and eligibility", async () => {
  for (let i = 0; i < 16; i++) {
    const ctx = fakeCtx({ now: 100000 }), { s, st } = capacityFixture();
    s.pacing.order = i % 2 ? ["cursor", "codex"] : [];
    s.execution.local_max_tasks = i % 3 ? 2 : null;
    s.runners.codex!.maxTasks = 4;
    s.runners["codex@devbox"]!.maxTasks = 4;
    const tasks = [record("running",ctx.now,{executor:"codex"}),record("running",ctx.now,{executor:"cursor"}),record("running",ctx.now,{executor:"codex@devbox",run:{host:"devbox"} as never})].map(t => ({ ...t, host:t.run?.host??null, updatedAt:ctx.now })) as unknown as ApiTask[];
    const p = st.providers.find(p => p.id === "codex")!;
    if (i === 1) p.blockedReason = "Authorization: Bearer sk-private-token\nsecret";
    if (i === 2) { p.brokenReason = "broken"; p.signedOutReason = "signed out"; }
    if (i === 3) { p.installed = false; p.signedOutReason = "signed out"; }
    if (i === 4) p.endpointNotTested = true;
    if (i === 5) s.runners.codex!.enabled = false;
    if (i >= 6 && i <= 8) p.eligibility = { state: i === 6 ? "ineligible" : i === 7 ? "uncertain" : "eligible", reasons:[{code:"budget_missing",evidenceIds:[]}],evaluatedAt:99900,evidenceAgeS:10,validUntil:null,availability:"ready",budget:i===6?"exhausted":"unknown",spendingRisk:"unknown" };
    if (i === 9) writeJsonAtomic(join(ctx.pacerHome,"state/runner-checks.json"), { codex:{at:ctx.now,passed:false,detail:"oops sk-private-token person@example.test"} });
    const actual = await rustRequest(ctx,{op:"capacity",status:st,strategy:s,tasks});
    const expected = {executors:buildExecutors(st,s,tasks,ctx.now,ctx),accounts:buildAccounts(st,s,ctx),planner:buildPlanner(st)};
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  }
},120_000);

test("Rust task titles, UTF-16 bounds, archived/old windows and legacy labels match TS", async () => {
  const ctx = fakeCtx();
  const goals = ["\uFEFFsummary:\n# Repair `foo` in the worker. Then reply", "😀".repeat(100)+" end", "- [Repair the worker](https://example.test/a(b)) and retry", "A snake_case __word__ under_score", "Repair /tmp/work/file.ts safely", "\u0085keep this", "Goal:\n```js\nconst x=1\n```\n# Start again!"];
  for (const [i, goal] of goals.entries()) {
    const t=record("queued",ctx.now,{id:`t-20261010-190000-${String(i).padStart(4,"0")}`,brief:{repo:ctx.home,goal}});
    const actual=await rustRequest(ctx,{op:"tasks",records:[t]});
    expect(JSON.stringify(actual)).toBe(JSON.stringify(apiTasks(ctx,[t])));
  }
},120_000);

test("Rust scoped auth marks, background checks, and host state keep current read-model semantics", async () => {
 const {markAuthFailed}=await import("../src/usage/auth");
 const {accountEvidenceScope}=await import("../src/evidence/scope");
 const ctx=fakeCtx({now:100000}), {s,st}=capacityFixture();
 st.providers=[];
 markAuthFailed(ctx,"claude-code","authentication failed",{scope:accountEvidenceScope(s.accounts["claude-code"]!,s.hosts)});
 writeJsonAtomic(join(ctx.pacerHome,"state/jobs/test.json"),{id:"test",kind:"runner.check",target:"codex",state:"running",startedAt:ctx.now,pid:process.pid});
 const actual=await rustRequest(ctx,{op:"capacity",status:st,strategy:s,tasks:[]});
 expect(JSON.stringify(actual)).toBe(JSON.stringify({executors:buildExecutors(st,s,[],ctx.now,ctx),accounts:buildAccounts(st,s,ctx),planner:buildPlanner(st)}));
},120_000);

test("Rust replay preserves hidden legacy event payloads separately from standalone conversion", async () => {
 const {appendOutbox}=await import("../src/link/store");
 const {eventsSince}=await import("../src/api/events");
 const ctx=fakeCtx();
 appendOutbox(ctx,[
  ...["machine","message","planner","desktop.update","liveness","notify"].map((kind,i)=>({seq:i+1,at:ctx.now,envelope:{type:"entity" as const,data:{kind,id:`row-${i}`,value:{id:`row-${i}`}}}} as never)),
  {seq:7,at:ctx.now,envelope:{type:"assistant",data:{turnId:"turn",conversationId:"conversation",state:"done"}}},
  {seq:8,at:ctx.now,envelope:{type:"config",data:{area:"machine",at:ctx.now}}},
 ]);
 for(const protocol of [2,3] as const){
  const actual=await rustRequest(ctx,{op:"events",since:0,protocol});
  expect(JSON.stringify(actual)).toBe(JSON.stringify(eventsSince(ctx,0,protocol)));
 }
},120_000);

test("Rust wire JSON preserves JS substrings ending in a UTF-16 high surrogate", async () => {
 const {createTask}=await import("../src/tasks/store");
 const {insertMessage}=await import("../src/messaging/store");
 const {appendOutbox}=await import("../src/link/store");
 const {eventsSince,liveSnapshot}=await import("../src/api/events");
 const {rustSnapshot}=await import("./read-model-rust-helpers");
 const ctx=fakeCtx({readOnly:true});
 for(const length of [199,999]){
  const task=createTask(ctx,{brief:{repo:ctx.home,goal:"Answer the question"},kind:null,requestedExecutor:null,timeoutS:60});
  insertMessage(ctx,{taskId:task.id,rootId:`task:${task.id}`,from:`task:${task.id}`,to:"human",kind:"question",body:"a".repeat(length)+"😀",replyTo:null,requestId:null});
  expect(JSON.stringify(await rustRequest(ctx,{op:"tasks",records:[task]}))).toBe(JSON.stringify(apiTasks(ctx,[task])));
  appendOutbox(ctx,[{seq:length,at:ctx.now,envelope:{type:"task",data:{id:task.id,state:task.state,goal:task.brief.goal,executor:null,backend:null,worktree:null,updatedAt:ctx.now}}}]);
 }
 for(const protocol of [2,3] as const)expect(JSON.stringify(await rustRequest(ctx,{op:"events",since:0,protocol}))).toBe(JSON.stringify(eventsSince(ctx,0,protocol)));
 const options={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}} as never)};
 const expected=await liveSnapshot(ctx,options);
 const actual=await rustSnapshot(ctx,expected,options,3) as typeof expected;
 expect(JSON.stringify(actual.snapshot.tasks)).toBe(JSON.stringify(expected.snapshot.tasks));
 expect(JSON.stringify(actual.snapshot.attention)).toBe(JSON.stringify(expected.snapshot.attention));
},120_000);

test("Rust legacy console cache keeps the 2-second window, 30/600-second leases and version filtering", async () => {
 const {liveV2Snapshot}=await import("../src/api/events");const {rustSnapshot}=await import("./read-model-rust-helpers");
 const ctx=fakeCtx({readOnly:true,which:()=>null});const options={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}} as never)};
 for(const offset of [0,1,2,31,601]){
  if(offset===1)writeJsonAtomic(join(ctx.pacerHome,"link/console.json"),{handle:"legacy",paneKey:"pane",pid:process.pid,startedAt:ctx.now,heartbeatAt:ctx.now});
  const at={...ctx,now:ctx.now+offset};const expected=await liveV2Snapshot(at,options);const actual=await rustSnapshot(at,expected,options,2) as typeof expected;
  for(const key of ["console","consoles"] as const){const normalize=(v:unknown)=>JSON.stringify(v).replaceAll(`"pid":${process.pid}`,'"pid":0');expect(normalize(actual.snapshot[key])).toBe(normalize(expected.snapshot[key]));}
 }
},120_000);

test("Rust pause redaction uses longest secrets first and retains bare carriage returns", async () => {
 const {liveSnapshot}=await import("../src/api/events");const {rustSnapshot}=await import("./read-model-rust-helpers");
 const ctx=fakeCtx({readOnly:true,which:()=>null,env:{API_KEY:"prefix",TOKEN:"prefix-tail"}});
 writeJsonAtomic(join(ctx.pacerHome,"state/pause.json"),{until:ctx.now+60,reason:"prefix-tail\nprivate",by:"person@example.test\r"});
 const options={status:async()=>({generatedAt:ctx.now,strategy:"default",planner:"codex",mode:"normal",disabled:false,calendarPace:false,providers:[],executors:{ranked:[],excluded:[]}} as never)};
 const expected=await liveSnapshot(ctx,options);const actual=await rustSnapshot(ctx,expected,options,3) as typeof expected;
 expect(actual.snapshot.pause).toEqual(expected.snapshot.pause);
},120_000);
