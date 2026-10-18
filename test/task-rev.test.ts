import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readLabels } from "../src/tasks/labels";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  return { ctx, task };
}

test("tasks start at revision 1 and every update increments the stored revision", () => {
  const { ctx, task } = fixture();
  expect(task.rev).toBe(1);
  expect(updateTask(ctx, task.id, t => { t.state = "done"; }).rev).toBe(2);
  expect(updateTask(ctx, task.id, () => {}).rev).toBe(3);
  expect(readTask(ctx, task.id)?.rev).toBe(3);
});

test("legacy tasks without rev read as revision 1 and update to revision 2", () => {
  const { ctx, task } = fixture();
  const file = join(ctx.pacerHome, "tasks", `${task.id}.json`);
  const legacy = JSON.parse(readFileSync(file, "utf8"));
  delete legacy.rev;
  writeFileSync(file, JSON.stringify(legacy));
  expect(readTask(ctx, task.id)?.rev).toBe(1);
  expect(updateTask(ctx, task.id, () => {}).rev).toBe(2);
});

test("stale review returns the current task in conflict data without recording a verdict", async () => {
  const { ctx, task } = fixture();
  updateTask(ctx, task.id, t => { t.state = "done"; });
  updateTask(ctx, task.id, () => {});
  const result = await callOp(ctx, "task.review", { id: task.id, verdict: "accept", expect_rev: 1 }).catch(toApiError);
  expect(result).toMatchObject({ code: "conflict", message: "task changed", data: { task: { id: task.id, rev: 3, repo: { key: expect.any(String) } } } });
  expect(readTask(ctx, task.id)?.review).toBeUndefined();
});

test("concurrent reviews with the same revision record exactly one verdict", async () => {
  const { ctx, task } = fixture();
  const rev = updateTask(ctx, task.id, t => { t.state = "done"; }).rev;
  const results = await Promise.allSettled([true, false].map(accepted => callOp(ctx, "task.review", { id: task.id, verdict: accepted ? "accept" : "reject", expect_rev: rev })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect(toApiError(rejected.reason)).toMatchObject({ code: "conflict", data: { task: { rev: rev + 1 } } });
  expect(readTask(ctx, task.id)?.rev).toBe(rev + 1);
  expect(readLabels(ctx).filter(label => label.type === "task_review")).toHaveLength(1);
});

for (const op of ["task.stop", "task.retry", "task.dismiss"]) {
  test(`${op} rejects stale revisions before side effects`, async () => {
    const { ctx, task } = fixture();
    updateTask(ctx, task.id, t => { t.state = "done"; });
    const params = op === "task.dismiss" ? { ids: [task.id], expect_rev: 1 } : { id: task.id, expect_rev: 1 };
    expect(await callOp(ctx, op, params).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { rev: 2 } } });
    expect(readTask(ctx, task.id)).toMatchObject({ state: "done", rev: 2 });
    expect(readTask(ctx, task.id)?.dismissed).toBeUndefined();
    expect(readTask(ctx, task.id)?.retriedBy).toBeUndefined();
  });
}

test("expect_rev validates positive integers", async () => {
  const { ctx, task } = fixture();
  for (const expect_rev of [0, -1, 1.5, "1"]) {
    expect(await callOp(ctx, "task.stop", { id: task.id, expect_rev }).catch(toApiError)).toMatchObject({ code: "invalid_input" });
  }
});


test("updates in separate processes do not lose revisions", async () => {
  const { ctx, task } = fixture();
  const script = `
    import { updateTask } from ${JSON.stringify(new URL("../src/tasks/store.ts", import.meta.url).pathname)};
    const ctx = JSON.parse(process.argv[1]);
    for (let i = 0; i < 20; i++) updateTask(ctx, process.argv[2], () => { Bun.sleepSync(2); });
  `;
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", script, JSON.stringify({ pacerHome: ctx.pacerHome }), task.id], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0]);
  expect(readTask(ctx, task.id)?.rev).toBe(61);
});

test("a stale request cannot refresh liveness before checking the revision", async () => {
  const { ctx, task } = fixture();
  ctx.now += 601;
  expect(await callOp(ctx, "task.stop", { id: task.id, expect_rev: 2 }).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { state: "queued", rev: 1 } } });
  expect(readTask(ctx, task.id)?.state).toBe("queued");
});

test("dismiss validates all revisions before changing the batch", async () => {
  const { ctx, task } = fixture();
  const other = createTask(ctx, { brief: task.brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, other.id, () => {});
  expect(await callOp(ctx, "task.dismiss", { ids: [task.id, other.id], expect_rev: 1 }).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { rev: 2 } } });
  expect(readTask(ctx, task.id)?.dismissed).toBeUndefined();
  expect(readTask(ctx, task.id)?.rev).toBe(1);
});
