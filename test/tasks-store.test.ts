import { expect, test } from "bun:test";
import { appendLabel, readLabels } from "../src/tasks/labels";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createTask, isTaskId, listTasks, newTaskId, readTask, tasksDir, taskStoreVersion, touchTask, updateTask } from "../src/tasks/store";
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

test("updateTask writes nothing when mutate changes nothing", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: "debug", requestedExecutor: null, timeoutS: 1800 });
  const file = join(tasksDir(ctx), `${t.id}.json`), mtime = statSync(file).mtimeMs, version = taskStoreVersion(ctx);
  const out = updateTask(ctx, t.id, x => { x.state = t.state; });
  expect(out.rev).toBe(t.rev);
  expect(readTask(ctx, t.id)!.rev).toBe(t.rev);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expect(taskStoreVersion(ctx)).toBe(version);
});

test("updateTask still writes a real change", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: "debug", requestedExecutor: null, timeoutS: 1800 });
  const out = updateTask(ctx, t.id, x => { x.question = { text: "Which branch?", at: ctx.now }; });
  expect(out.rev).toBe(t.rev + 1);
  expect(readTask(ctx, t.id)!.question?.text).toBe("Which branch?");
});

test("touchTask bumps the revision without changing the record", () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief, kind: "debug", requestedExecutor: null, timeoutS: 1800 });
  const out = touchTask(ctx, t.id);
  expect(out.rev).toBe(t.rev + 1);
  expect({ ...readTask(ctx, t.id)!, rev: t.rev }).toEqual({ ...t, rev: t.rev });
});

test("worker preparation conflicts promptly with sync writes and serializes async writes", async () => {
  const { withTaskLockAsync } = await import("../src/tasks/store");
  const { preparationWorker } = await import("./task-preparation-worker-helper");
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const w = preparationWorker(ctx, task.id);
  try {
    w.send("prepare");
    expect((await w.wait("held")).type).toBe("held");
    const started = performance.now();
    expect(() => updateTask({ ...ctx, operation: { signal: new AbortController().signal } }, task.id, t => { t.kind = "rejected"; })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(performance.now() - started).toBeLessThan(200);
    expect(readTask(ctx, task.id)?.kind).toBeNull();
    let committed = false;
    const pending = withTaskLockAsync(ctx, task.id, () => {
      expect(readTask(ctx, task.id)?.kind).toBe("prepared");
      updateTask(ctx, task.id, t => { t.kind = "after"; });
      committed = true;
    });
    await Bun.sleep(60);
    expect(committed).toBe(false);
    w.send("release");
    expect((await w.wait("done")).type).toBe("done");
    await pending;
    expect(readTask(ctx, task.id)?.kind).toBe("after");
  } finally { w.send("release"); w.worker.terminate(); }
});

test("main admission preparation rejects worker mutation without blocking its isolate", async () => {
  const { withTaskPreparation } = await import("../src/tasks/store");
  const { preparationWorker } = await import("./task-preparation-worker-helper");
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const w = preparationWorker(ctx, task.id);
  try {
    await withTaskPreparation(ctx, task.id, async () => {
      w.send("mutate");
      expect(await w.wait("error")).toMatchObject({ code: "conflict" });
      expect(readTask(ctx, task.id)?.kind).toBeNull();
    }, () => updateTask(ctx, task.id, t => { t.kind = "main"; }));
    expect(readTask(ctx, task.id)?.kind).toBe("main");
  } finally { w.worker.terminate(); }
});

test("task writes respect offline lock files and recover stale owners", async () => {
  const { existsSync, mkdirSync, writeFileSync, utimesSync, rmSync } = await import("node:fs");
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const directory = join(ctx.pacerHome, "orca");
  const lock = join(directory, `task-${task.id}.lock`);
  mkdirSync(directory, { recursive: true });
  // The Rust/offline protocol is exclusive creation of this same empty file.
  writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
  try {
    expect(() => updateTask({ ...ctx, operation: { signal: new AbortController().signal } }, task.id, t => { t.kind = "blocked"; })).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(existsSync(lock)).toBe(true);
    expect(readTask(ctx, task.id)?.kind).toBeNull();
    const stale = new Date(Date.now() - 121_000);
    utimesSync(lock, stale, stale);
    updateTask(ctx, task.id, t => { t.kind = "recovered"; });
    expect(readTask(ctx, task.id)?.kind).toBe("recovered");
    expect(existsSync(lock)).toBe(false);
  } finally { rmSync(lock, { force: true }); }
});


test("internal synchronous completion retains bounded wait under a foreign lock", async () => {
  const { preparationWorker } = await import("./task-preparation-worker-helper");
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  const worker = preparationWorker(ctx, task.id);
  try {
    worker.send("prepare-bounded");
    expect((await worker.wait("held")).type).toBe("held");
    const result = updateTask(ctx, task.id, current => {
      expect(current.kind).toBe("prepared");
      current.kind = "completed";
    });
    expect(result.kind).toBe("completed");
    expect(readTask(ctx, task.id)?.kind).toBe("completed");
    expect((await worker.wait("done")).type).toBe("done");
  } finally { worker.send("release"); worker.worker.terminate(); }
});
