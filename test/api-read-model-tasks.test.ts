import { expect, test } from "bun:test";
import { apiTask, needsReview, snapshotTasks } from "../src/api/read-model/tasks";
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
