import { expect, test } from "bun:test";
import { apiSnapshot, eventsSince } from "../src/api/events";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { fakeCtx } from "./helpers";

const alert = (key: string, at: number) => ({ v: 1 as const, type: "alert" as const, data: { key, level: "info" as const, title: key, body: "", at } });

test("events after a seq, in order, with their envelope type and data", async () => {
  const ctx = fakeCtx();
  await publish(ctx, [alert("a", ctx.now), alert("b", ctx.now)], { bridge: false, channel: false });
  const all = eventsSince(ctx, 0);
  expect(all.events.map((e) => [e.type, (e.data as { key: string }).key])).toEqual([["alert", "a"], ["alert", "b"]]);
  expect(all.reset).toBe(false);
  const later = eventsSince(ctx, all.events[0].seq);
  expect(later.events.map((e) => (e.data as { key: string }).key)).toEqual(["b"]);
  expect(later.last).toBe(all.last);
});

test("a since older than the retained outbox yields reset", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [{ seq: 50, envelope: alert("x", ctx.now) }, { seq: 51, envelope: alert("y", ctx.now) }]);
  const r = eventsSince(ctx, 10);
  expect(r.reset).toBe(true);
  expect(r.events[0]).toMatchObject({ type: "reset", seq: 49 });
  expect(r.events.slice(1).map((e) => e.seq)).toEqual([50, 51]);
});

test("the snapshot carries the protocol version and its seq", async () => {
  const ctx = fakeCtx();
  await publish(ctx, [alert("a", ctx.now)], { bridge: false, channel: false });
  expect(await apiSnapshot(ctx)).toMatchObject({ protocol: "2.7.0", seq: eventsSince(ctx, 0).last });
});

test("events retain publication time and map internal entities", async () => {
 const ctx=fakeCtx();
 await publish(ctx,[alert("time",ctx.now),{v:1,type:"entity",data:{kind:"executor",id:"codex#team",value:{id:"codex#team"}}},{v:1,type:"entity",data:{kind:"executor",id:"codex#team",removed:true}}],{bridge:false,channel:false});
 const events=eventsSince({...ctx,now:ctx.now+100},0).events;
 expect(events[0]!.at).toBe(ctx.now);
 expect(events[1]).toMatchObject({type:"executor",data:{id:"codex#team"}});
 expect(events[2]).toMatchObject({type:"executor",data:{id:"codex#team",removed:true}});
});
test("entity validation and 1000-entry retention", async () => {
 const {parseEnvelope}=await import("../src/link/envelope");
 const {readOutboxSince}=await import("../src/link/store");
 expect(parseEnvelope({v:1,type:"entity",data:{kind:"task",id:"x"}})).toBeNull();
 const ctx=fakeCtx();
 await publish(ctx,Array.from({length:1200},(_,i)=>alert(String(i),ctx.now)),{bridge:false,channel:false});
 expect(readOutboxSince(ctx,0)).toHaveLength(1000);
});

test("v2 task events include repo, kind and host without changing v1 envelopes",async()=>{
 const {createTask,updateTask}=await import("../src/tasks/store");
 const {taskData}=await import("../src/link/pump");
 const ctx=fakeCtx(),t=createTask(ctx,{brief:{repo:"/missing/repo",goal:"g"},kind:"feature",requestedExecutor:null,timeoutS:60});
 const ref={key:"github.com/acme/api",label:"acme/api",path:"/api"};
 const record=updateTask(ctx,t.id,t=>{t.repo=ref;});
 await publish(ctx,[{v:1,type:"task",data:taskData(record)}],{bridge:false,channel:false});
 expect(eventsSince(ctx,0).events[0]?.data).toMatchObject({repo:ref,kind:"feature",host:null});
 expect((await import("../src/link/store")).readOutboxSince(ctx,0)[0]?.envelope.data).not.toHaveProperty("repo");
});

test("hello advertises additive 2.1 events for clients that skip unknown event types",async()=>{
 const {helloBody}=await import("../src/api/protocol");
 expect(helloBody()).toMatchObject({protocol:"2.7.0",events:expect.arrayContaining(["budget","task","mode","alert","config","reset","executor","account","host","repo","counts"])});
});

test("snapshot reads drain queued tasks even without a daemon", async () => {
  const {mkdirSync} = await import("node:fs"), {join} = await import("node:path");
  const {createTask, updateTask, readTask} = await import("../src/tasks/store");
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const t = createTask(ctx, {brief: {goal: "work", repo: ctx.home}, kind: null, requestedExecutor: "removed", timeoutS: 60});
  updateTask(ctx, t.id, x => {x.queue = {reason: "no_slot", since: ctx.now, position: 1};});
  await apiSnapshot(ctx);
  expect(readTask(ctx, t.id)?.result?.report).toBe("removed was removed while the task waited");
});
