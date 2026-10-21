import { expect, test } from "bun:test";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { apiTask } from "../src/api/read-model/tasks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readLabels } from "../src/tasks/labels";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "Review permissions", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; });
  return { ctx, id: task.id };
}

test("review handoff persists a normalized note without accepting the result", async () => {
  const { ctx, id } = fixture();
  const result = await callOp(ctx, "task.request_review", { id, note: "  Check access permissions  ", expect_rev: 2 });
  expect(result).toMatchObject({ task: { id, rev: 3, reviewRequest: { note: "Check access permissions", at: ctx.now } } });
  expect(readTask({ ...ctx }, id)?.reviewRequest?.note).toBe("Check access permissions");
  expect(apiTask(ctx, readTask(ctx, id)!)).toMatchObject({ reviewRequest: { note: "Check access permissions" }, acceptanceState: "none" });
  expect(readTask(ctx, id)?.review).toBeUndefined();
  expect(readLabels(ctx)).toEqual([]);
});

test("same handoff is idempotent but stale revisions still conflict", async () => {
  const { ctx, id } = fixture();
  await callOp(ctx, "task.request_review", { id, note: "Check" });
  ctx.now += 20;
  await callOp(ctx, "task.request_review", { id, note: "Check", expect_rev: 3 });
  expect(readTask(ctx, id)).toMatchObject({ rev: 3, reviewRequest: { at: ctx.now - 20 } });
  expect(await callOp(ctx, "task.request_review", { id, note: "Check", expect_rev: 2 }).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { rev: 3 } } });
  await callOp(ctx, "task.request_review", { id, note: "Check again", expect_rev: 3 });
  expect(readTask(ctx, id)).toMatchObject({ rev: 4, reviewRequest: { note: "Check again", at: ctx.now } });
});

test("handoff validates note, state and concurrent mutations", async () => {
  const { ctx, id } = fixture();
  for (const note of ["", "   ", "x".repeat(2001)]) {
    expect(await callOp(ctx, "task.request_review", { id, note }).catch(toApiError)).toMatchObject({ code: "invalid_input" });
  }
  const results = await Promise.allSettled(["First", "Second"].map(note => callOp(ctx, "task.request_review", { id, note, expect_rev: 2 })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(toApiError((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toMatchObject({ code: "conflict" });
  for (const state of ["queued", "running", "failed", "limit", "stopped", "needs_input"] as const) {
    updateTask(ctx, id, t => { t.state = state; });
    expect(await callOp(ctx, "task.request_review", { id, note: "Check" }).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { state } } });
  }
  updateTask(ctx, id, t => { t.state = "partial"; });
  expect(await callOp(ctx, "task.request_review", { id, note: "Check partial" })).toMatchObject({ task: { state: "partial" } });
  for (const patch of [{ dismissed: true }, { resolved: "reviewed" }, { retriedBy: "next" }, { review: { accepted: true, kind: null, note: null, at: ctx.now } }]) {
    const next = fixture();
    updateTask(next.ctx, next.id, t => Object.assign(t, patch));
    expect(await callOp(next.ctx, "task.request_review", { id: next.id, note: "Check" }).catch(toApiError)).toMatchObject({ code: "conflict" });
  }
  expect(await callOp(ctx, "task.request_review", { id: "missing", note: "Check" }).catch(toApiError)).toMatchObject({ code: "unknown_task" });
});

test("requesting review brings an old result back into the recent snapshot", async()=>{
 const {ctx,id}=fixture();
 ctx.now+=172800;
 await callOp(ctx,"task.request_review",{id,note:"Check an older result"});
 const {snapshotTasks}=await import("../src/api/read-model/tasks");
 expect(snapshotTasks(ctx,[readTask(ctx,id)!]).map(t=>t.id)).toContain(id);
});
