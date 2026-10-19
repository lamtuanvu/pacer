import { expect, test } from "bun:test";
import { apiTask, needsReview, snapshotTasks, supersededTaskIds } from "../src/api/read-model/tasks";
import { fakeCtx } from "./helpers";
import { record } from "./read-model-helpers";
test("task window keeps active and recent undismissed settled tasks",()=>{
 const ctx=fakeCtx(),rows=snapshotTasks(ctx,[record("running",ctx.now-3*86400),record("done",ctx.now-25*3600),record("done",ctx.now-3600),record("failed",ctx.now-3600,{dismissed:true})]);
 expect(rows.map(t=>t.state)).toEqual(["done","running"]);
 expect(rows[0]!.repo.key).toMatch(/^local:/);
 expect(apiTask(ctx,record("done",ctx.now)).host).toBeNull();
 expect(needsReview({...rows[0]!,retriedBy:"new"})).toBe(false);
});
test("task window caps newest first at 200",()=>{
 const ctx=fakeCtx(),rows=snapshotTasks(ctx,Array.from({length:250},(_,i)=>record("queued",ctx.now-i)));
 expect(rows).toHaveLength(200);expect(rows[0]!.updatedAt).toBe(ctx.now);expect(rows[199]!.updatedAt).toBe(ctx.now-199);
});

test("stored repo labels are normalized when different hosts clash",()=>{
 const ctx=fakeCtx();
 const records=["github.com/acme/api","gitlab.com/acme/api"].map((key,i)=>record("done",ctx.now-i,{repo:{key,label:"acme/api",path:`/repo${i}`}}));
 expect(snapshotTasks(ctx,records).map(t=>t.repo.label)).toEqual(["github.com/acme/api","gitlab.com/acme/api"]);
});

test("task snapshots derive titles for older records and retain stored titles",()=>{
 const ctx=fakeCtx();
 expect(apiTask(ctx,record("done",ctx.now,{brief:{goal:"Fix the queue. Then run tests",repo:ctx.home}})).title).toBe("Fix the queue");
 expect(snapshotTasks(ctx,[record("done",ctx.now,{title:"Queue fix"})])[0]?.title).toBe("Queue fix");
});


test("superseded status requires a present, undismissed, unstopped retry",()=>{
 const ctx=fakeCtx();
 for(const state of ["queued","running","done","failed","stopped"] as const) for(const dismissed of [false,true]) for(const link of ["forward","reverse","both"] as const) {
  const original=apiTask(ctx,record("failed",ctx.now-10)),retry=apiTask(ctx,record(state,ctx.now,{dismissed}));
  if(link!=="reverse")original.retriedBy=retry.id;
  if(link!=="forward")retry.retryOf=original.id;
  expect(supersededTaskIds([original,retry]).has(original.id)).toBe(!dismissed&&state!=="stopped");
  expect(supersededTaskIds([original]).has(original.id)).toBe(false);
 }
});

test("task snapshots clip stored emoji titles without splitting code points",()=>{
 const ctx=fakeCtx(),title="🚀".repeat(61);
 expect(apiTask(ctx,record("done",ctx.now,{title})).title).toBe("🚀".repeat(59)+"…");
});

test("snapshots preserve the scheduling limit and capacity on queued tasks",()=>{
 const ctx=fakeCtx();
 for(const limit of ['executor','machine','host'] as const) {
  const queue={reason:'no_slot' as const,since:ctx.now,position:1,limit,capacity:{used:2,max:2}};
  expect(snapshotTasks(ctx,[record('queued',ctx.now,{queue})])[0]!.queue).toEqual(queue);
 }
});
