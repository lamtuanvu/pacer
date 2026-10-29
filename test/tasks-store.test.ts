import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("labels create a 0700 directory and a 0600 file even under a permissive umask (SEC-7)", () => {
  const ctx = fakeCtx();
  const before = process.umask(0);
  try { appendLabel(ctx, { type: "guard_verdict", event_id: "e-1", blocked: true, source: "rules" }); }
  finally { process.umask(before); }
  expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
  expect(statSync(join(ctx.pacerHome, "labels.jsonl")).mode & 0o777).toBe(0o600);

  // An existing, wider file is narrowed on the next append.
  chmodSync(join(ctx.pacerHome, "labels.jsonl"), 0o644);
  appendLabel(ctx, { type: "guard_verdict", event_id: "e-2", blocked: false, source: "rules" });
  expect(statSync(join(ctx.pacerHome, "labels.jsonl")).mode & 0o777).toBe(0o600);
  expect(readLabels(ctx).map((label) => label.event_id)).toEqual(["e-1", "e-2"]);
});

test("labels narrow an existing, wider pacer home to 0700 before writing (SEC-7)", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  chmodSync(ctx.pacerHome, 0o755);
  appendLabel(ctx, { type: "guard_verdict", event_id: "e-1", blocked: true, source: "rules" });
  expect(statSync(ctx.pacerHome).mode & 0o777).toBe(0o700);
  expect(statSync(join(ctx.pacerHome, "labels.jsonl")).mode & 0o777).toBe(0o600);
});

test("a label appended after an interrupted append starts on a new line (SEC-7 append exception)", () => {
  const ctx = fakeCtx();
  appendLabel(ctx, { type: "task_review", task_id: "t-1", accepted: true });
  appendFileSync(join(ctx.pacerHome, "labels.jsonl"), '{"ts":1,"type":"task_rev');
  appendLabel(ctx, { type: "task_review", task_id: "t-2", accepted: false });
  const lines = readFileSync(join(ctx.pacerHome, "labels.jsonl"), "utf8").split("\n");
  expect(lines.at(-2)).toBe(JSON.stringify({ ts: ctx.now, type: "task_review", task_id: "t-2", accepted: false }));
  expect(readLabels(ctx).map((label) => label.task_id)).toEqual(["t-1", "t-2"]);
  appendLabel(ctx, { type: "task_review", task_id: "t-3", accepted: true });
  expect(readLabels(ctx).map((label) => label.task_id)).toEqual(["t-1", "t-2", "t-3"]);
});

test("labels appended concurrently from several processes stay whole lines (SEC-7)", async () => {
  const ctx = fakeCtx();
  const script = join(ctx.home, "append.ts");
  writeFileSync(script, [
    `import { appendLabel } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tasks", "labels"))};`,
    `const ctx = { home: ${JSON.stringify(ctx.home)}, pacerHome: ${JSON.stringify(ctx.pacerHome)}, now: 1, env: {} };`,
    `for (let i = 0; i < 25; i++) appendLabel(ctx as never, { type: "guard_verdict", worker: process.argv[2], i, pad: "x".repeat(70000) });`,
  ].join("\n"));
  const workers = Array.from({ length: 6 }, (_, n) => Bun.spawn([process.execPath, script, String(n)], { stdout: "ignore", stderr: "inherit" }));
  expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual([0, 0, 0, 0, 0, 0]);
  const lines = (await Bun.file(join(ctx.pacerHome, "labels.jsonl")).text()).split("\n").filter(Boolean);
  expect(lines).toHaveLength(150);
  expect(readLabels(ctx)).toHaveLength(150);
  expect(new Set(readLabels(ctx).map((label) => `${label.worker}:${label.i}`)).size).toBe(150);
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
