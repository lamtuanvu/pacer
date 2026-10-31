import { expect, test } from "bun:test";
import { apiSnapshot, eventsSince } from "../src/api/events";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { fakeCtx } from "./helpers";

const alert = (key: string, at: number) => ({ type: "alert" as const, data: { key, level: "info" as const, title: key, body: "", at } });

test("events after a seq, in order, with their envelope type and data", async () => {
  const ctx = fakeCtx();
  await publish(ctx, [alert("a", ctx.now), alert("b", ctx.now)]);
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
  await publish(ctx, [alert("a", ctx.now)]);
  expect(await apiSnapshot(ctx)).toMatchObject({ protocol: "3.0.0", seq: eventsSince(ctx, 0, 3).last });
});

test("events retain publication time and map internal entities", async () => {
 const ctx=fakeCtx();
 await publish(ctx,[alert("time",ctx.now),{type:"entity",data:{kind:"executor",id:"codex#team",value:{id:"codex#team"}}},{type:"entity",data:{kind:"executor",id:"codex#team",removed:true}}]);
 const events=eventsSince({...ctx,now:ctx.now+100},0).events;
 expect(events[0]!.at).toBe(ctx.now);
 expect(events[1]).toMatchObject({type:"executor",data:{id:"codex#team"}});
 expect(events[2]).toMatchObject({type:"executor",data:{id:"codex#team",removed:true}});
});
test("entity validation and 1000-entry retention", async () => {
 const {parseOutboxEvent}=await import("../src/link/envelope");
 const {readOutboxSince}=await import("../src/link/store");
 expect(parseOutboxEvent({type:"entity",data:{kind:"task",id:"x"}})).toBeNull();
 const ctx=fakeCtx();
 await publish(ctx,Array.from({length:1200},(_,i)=>alert(String(i),ctx.now)));
 expect(readOutboxSince(ctx,0)).toHaveLength(1000);
});

test("v2 task events include repo, kind and host without changing v1 envelopes",async()=>{
 const {createTask,updateTask}=await import("../src/tasks/store");
 const {taskData}=await import("../src/link/pump");
 const ctx=fakeCtx(),t=createTask(ctx,{brief:{repo:"/missing/repo",goal:"g"},kind:"feature",requestedExecutor:null,timeoutS:60});
 const ref={key:"github.com/acme/api",label:"acme/api",path:"/api"};
 const record=updateTask(ctx,t.id,t=>{t.repo=ref;});
 await publish(ctx,[{type:"task",data:taskData(record)}]);
 expect(eventsSince(ctx,0).events[0]?.data).toMatchObject({repo:ref,kind:"feature",host:null});
 expect((await import("../src/link/store")).readOutboxSince(ctx,0)[0]?.envelope.data).not.toHaveProperty("repo");
});

test("hello advertises additive 2.1 events for clients that skip unknown event types",async()=>{
 const {v2Hello:helloBody}=await import("../src/api/v2-compat");
 expect(helloBody()).toMatchObject({protocol:"2.8.0",events:expect.arrayContaining(["budget","task","mode","alert","config","reset","executor","account","host","repo","counts"])});
});

async function queuedTaskWithRemovedExecutor() {
  const {mkdirSync} = await import("node:fs"), {join} = await import("node:path");
  const {createTask, updateTask} = await import("../src/tasks/store");
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const t = createTask(ctx, {brief: {goal: "work", repo: ctx.home}, kind: null, requestedExecutor: "removed", timeoutS: 60});
  const task = updateTask(ctx, t.id, x => {x.queue = {reason: "no_slot", since: ctx.now, position: 1};});
  return {ctx, task};
}

test("snapshot reads leave queued tasks and their revisions unchanged", async () => {
  const {readTask} = await import("../src/tasks/store");
  const {ctx, task} = await queuedTaskWithRemovedExecutor();
  expect(task.state).toBe("queued");
  await apiSnapshot(ctx);
  expect(readTask(ctx, task.id)).toEqual(task);
});

test("service supervision and queue draining settle a task whose executor was removed", async () => {
  const {superviseTasks} = await import("../src/tasks/api");
  const {drainQueue} = await import("../src/tasks/drain");
  const {readTask} = await import("../src/tasks/store");
  const {ctx, task} = await queuedTaskWithRemovedExecutor();
  await superviseTasks(ctx);
  await drainQueue(ctx);
  const settled = readTask(ctx, task.id);
  expect(settled).toMatchObject({state: "failed", result: {report: "removed was removed while the task waited"}});
  expect(settled?.queue).toBeUndefined();
});

test("task events expose clean derived titles and complete explicit titles, including retained legacy events",async()=>{
 const {createTask,updateTask}=await import("../src/tasks/store");
 const {taskData}=await import("../src/link/pump");
 const ctx=fakeCtx(),t=createTask(ctx,{brief:{goal:"Fix queue. Then test",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 await publish(ctx,[{type:"task",data:taskData(t)}]);
 expect(eventsSince(ctx,0).events[0]?.data).toMatchObject({title:"Fix queue",fullTitle:"Fix queue"});
 const record=updateTask(ctx,t.id,t=>{t.title="Queue fix (keep src/core/tasks.ts and `bun run test`). Verify all workers " + "without clipping ".repeat(10);});
 await publish(ctx,[{type:"task",data:taskData(record)}]);
 expect(eventsSince(ctx,1).events[0]?.data).toMatchObject({fullTitle:record.title!.trim()});
 appendOutbox(ctx,[{seq:3,envelope:{type:"task",data:{...taskData(t),id:"deleted",title:undefined}}}]);
 expect(eventsSince(ctx,2).events[0]?.data).toMatchObject({title:"Fix queue",fullTitle:"Fix queue"});
});
