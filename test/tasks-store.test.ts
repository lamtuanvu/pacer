import { expect, test } from "bun:test";
import { appendLabel, readLabels } from "../src/tasks/labels";
import { createTask, isTaskId, listTasks, newTaskId, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, localTs } from "./helpers";

const brief = { goal: "Fix the bug", repo: "/tmp/repo", acceptance: "bun test" };

test("task ids are timestamped, random-suffixed and validated", () => {
  const id = newTaskId(localTs(2026, 10, 11, 14, 5));
  expect(id).toMatch(/^t-20261011-140500-[0-9a-f]{4}$/);
  expect(isTaskId(id)).toBe(true);
  expect(isTaskId("../../etc/passwd")).toBe(false);
  expect(isTaskId("t-20261011-140500-zzzz")).toBe(false);
});

test("create, read, update and list tasks", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: "debug", requestedExecutor: null, timeoutS: 1800 });
  expect(t).toMatchObject({ state: "queued", kind: "debug", attempts: [], timeoutS: 1800, createdAt: ctx.now });
  expect(readTask(ctx, t.id)).toEqual(t);
  const u = updateTask(ctx, t.id, (x) => { x.state = "running"; x.runnerPid = 42; });
  expect(u.state).toBe("running");
  expect(readTask(ctx, t.id)?.runnerPid).toBe(42);
  const t2 = createTask({ ...ctx, now: ctx.now + 5 }, { brief, kind: null, requestedExecutor: "codex", timeoutS: 60 });
  expect(listTasks(ctx).map((x) => x.id)).toEqual([t2.id, t.id]);
  expect(listTasks(ctx, 1).length).toBe(1);
});

test("unknown or malformed ids read as null; updating one throws", () => {
  const ctx = fakeCtx();
  expect(readTask(ctx, "t-20261011-140500-abcd")).toBeNull();
  expect(readTask(ctx, "../x")).toBeNull();
  expect(() => updateTask(ctx, "t-20261011-140500-abcd", () => {})).toThrow("unknown task");
  expect(listTasks(ctx)).toEqual([]);
});

test("labels append as JSON lines with a timestamp and skip corrupt lines on read", async () => {
  const ctx = fakeCtx();
  appendLabel(ctx, { type: "task_review", task_id: "t-1", accepted: true });
  appendLabel(ctx, { type: "guard_feedback", event_id: "e-1", correct: false });
  await Bun.write(`${ctx.pacerHome}/labels.jsonl`, (await Bun.file(`${ctx.pacerHome}/labels.jsonl`).text()) + "{oops\n");
  expect(readLabels(ctx)).toEqual([
    { ts: ctx.now, type: "task_review", task_id: "t-1", accepted: true },
    { ts: ctx.now, type: "guard_feedback", event_id: "e-1", correct: false },
  ]);
});
