import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { createTask, readTask, touchTask, updateTask } from "../src/tasks/store";
import { readLabels } from "../src/tasks/labels";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  return { ctx, task };
}

test("tasks start at revision 1 and every real update or touch increments the stored revision", () => {
  const { ctx, task } = fixture();
  expect(task.rev).toBe(1);
  expect(updateTask(ctx, task.id, t => { t.state = "done"; }).rev).toBe(2);
  expect(updateTask(ctx, task.id, () => {}).rev).toBe(2);
  expect(touchTask(ctx, task.id).rev).toBe(3);
  expect(readTask(ctx, task.id)?.rev).toBe(3);
});

test("legacy tasks without rev read as revision 1 and update to revision 2", () => {
  const ctx = fakeCtx();
  const task = { id: "t-20261019-120000-abcd", createdAt: ctx.now, state: "queued", attempts: [],
    brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 };
  mkdirSync(join(ctx.pacerHome, "tasks"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "tasks", `${task.id}.json`), JSON.stringify(task));
  expect(readTask(ctx, task.id)?.rev).toBe(1);
  expect(touchTask(ctx, task.id).rev).toBe(2);
});

test("stale review returns the current task in conflict data without recording a verdict", async () => {
  const { ctx, task } = fixture();
  updateTask(ctx, task.id, t => { t.state = "done"; });
  touchTask(ctx, task.id);
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
    // Each write is a real change, held under the task lock long enough to contend.
    for (let i = 0; i < 20; i++) updateTask(ctx, process.argv[2], t => { Bun.sleepSync(2); t.question = { text: process.pid + ":" + i, at: 0 }; });
  `;
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", script, JSON.stringify({ pacerHome: ctx.pacerHome }), task.id], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0, 0]);
  expect(readTask(ctx, task.id)?.rev).toBe(61);
});

test("cross-process reviews serialize the SQLite revision and record one verdict", async () => {
  const { ctx, task } = fixture();
  const rev = updateTask(ctx, task.id, t => { t.state = "done"; }).rev;
  const release = join(ctx.home, "review-release");
  const workers = ["accept", "reject"].map((verdict, index) => {
    const ready = join(ctx.home, `review-ready-${index}`);
    const child = Bun.spawn([process.execPath, new URL("./fixtures/task-admission/review-worker.ts", import.meta.url).pathname,
      ctx.pacerHome, task.id, String(rev), verdict, ready, release], { stdout: "pipe", stderr: "pipe" });
    return { child, ready };
  });
  const until = Date.now() + 10_000;
  while (workers.some(worker => !existsSync(worker.ready)) && Date.now() < until) await Bun.sleep(5);
  expect(workers.every(worker => existsSync(worker.ready))).toBe(true);
  writeFileSync(release, "go");
  const outcomes = await Promise.all(workers.map(async ({ child }) => {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    return JSON.parse(stdout.trim()) as { ok?: boolean; code?: string; rev?: number };
  }));
  expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
  expect(outcomes.filter(outcome => outcome.code === "conflict")).toEqual([{ code: "conflict", rev: rev + 1 }]);
  expect(readTask(ctx, task.id)?.rev).toBe(rev + 1);
  expect(readLabels(ctx).filter(label => label.type === "task_review")).toHaveLength(1);
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
  touchTask(ctx, other.id);
  expect(await callOp(ctx, "task.dismiss", { ids: [task.id, other.id], expect_rev: 1 }).catch(toApiError)).toMatchObject({ code: "conflict", data: { task: { rev: 2 } } });
  expect(readTask(ctx, task.id)?.dismissed).toBeUndefined();
  expect(readTask(ctx, task.id)?.rev).toBe(1);
});
