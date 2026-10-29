import { expect, test } from "bun:test";
import { runTask } from "../src/tasks/runner";
import { readTask, updateTask } from "../src/tasks/store";
import { drainMachineWaits, superviseTask } from "../src/tasks/api";
import { setMachineReaders } from "../src/engine/machine";
import { afterEach } from "bun:test";
import { fakeCtx } from "./helpers";

import { queueStrategy, queueTask, queueDeps } from "./queue-helpers";

for (const second of [false, true]) test(`full executor ${second ? "falls through" : "queues without an attempt"}`, async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b");
  updateTask(ctx, a.id, t => {t.state = "running"; t.executor = "codex"; t.runnerPid = process.pid;});
  const result = await runTask(ctx, b.id, queueDeps(queueStrategy(second)));
  if (second) expect(result.result?.executor).toBe("cursor");
  else {expect(result.state).toBe("queued"); expect(result.queue).toMatchObject({reason: "no_slot", position: 1, limit: "executor", capacity: {used: 1, max: 1}}); expect(result.attempts).toEqual([]);}
});
test("a full pinned executor queues even with a free fallback", async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b", "codex");
  updateTask(ctx, a.id, t => {t.state = "running"; t.executor = "codex";});
  expect((await runTask(ctx, b.id, queueDeps(queueStrategy(true)))).queue?.reason).toBe("no_slot");
});
test("concurrent runners reserve one slot atomically", async () => {
  const ctx = fakeCtx(), a = queueTask(ctx, "a"), b = queueTask(ctx, "b"), deps = queueDeps();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => {release = r;}), started = new Promise<void>(r => {entered = r;});
  deps.runAttempt = async (...args) => {entered(); await gate; return queueDeps().runAttempt!(...args);};
  const first = runTask(ctx, a.id, deps), second = runTask(ctx, b.id, deps); await started;
  const queued = await Promise.race([first, second]);
  expect([readTask(ctx, a.id)?.state, readTask(ctx, b.id)?.state].sort()).toEqual(["queued", "running"]);
  expect(queued.queue?.reason).toBe("no_slot");
  release(); await Promise.all([first, second]);
});
test("waiting tasks survive the never-started timeout", async () => {
  const ctx = fakeCtx(), t = queueTask(ctx);
  updateTask(ctx, t.id, x => {x.queue = {reason: "no_slot", since: ctx.now, position: 1};});
  expect((await superviseTask({...ctx, now: ctx.now + 700}, t.id))?.state).toBe("queued");
});
test("a runner that starts during a pause queues without attempting", async () => {
  const {pause} = await import("../src/core/pause");
  const ctx = fakeCtx(), task = queueTask(ctx);
  pause(ctx, {for: "1h"});
  expect(await runTask(ctx, task.id, queueDeps())).toMatchObject({state: "queued", queue: {reason: "paused"}, attempts: []});
});
test("machine capacity queues a different executor", async () => {
  const ctx = fakeCtx(), active = queueTask(ctx, "active"), task = queueTask(ctx, "waiting", "cursor");
  updateTask(ctx, active.id, t => {t.state = "running"; t.executor = "codex";});
  const s = queueStrategy(true); s.execution.local_max_tasks = 1;
  expect((await runTask(ctx, task.id, queueDeps(s))).queue).toMatchObject({reason: "no_slot", limit: "machine", capacity: {used: 1, max: 1}});
});

const calm = () => setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
afterEach(calm);
test("no fixed machine cap by default: local tasks start alongside running ones", async () => {
  const ctx = fakeCtx(), active = queueTask(ctx, "active", "codex"), task = queueTask(ctx, "next", "cursor");
  updateTask(ctx, active.id, t => {t.state = "running"; t.executor = "codex"; t.runnerPid = process.pid;});
  expect((await runTask(ctx, task.id, queueDeps(queueStrategy(true)))).result?.executor).toBe("cursor");
});
test("memory pressure holds a new local task with the observed reason", async () => {
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  const ctx = fakeCtx(), task = queueTask(ctx);
  const result = await runTask(ctx, task.id, queueDeps());
  expect(result).toMatchObject({state: "queued", attempts: [], queue: {reason: "machine_memory_pressure", limit: "machine", detail: "memory pressure critical", machine: {memoryPressure: "critical", memoryPressureLimit: "critical"}}});
  expect(result.queue?.capacity).toBeUndefined();
});
test("load ceiling holds a new local task with the observed load", async () => {
  setMachineReaders({pressure: () => 1, load: () => ({avg1: 59, cores: 12})});
  const ctx = fakeCtx(), task = queueTask(ctx), s = queueStrategy(); s.execution.local_load_limit = 3;
  expect((await runTask(ctx, task.id, queueDeps(s))).queue).toMatchObject({reason: "machine_load", detail: "load 4.9/core over limit 3", machine: {loadPerCore: 4.92, loadLimit: 3}});
});
test("the periodic re-check starts a waiting task once memory pressure drops, with no task finishing", async () => {
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  const ctx = fakeCtx(), task = queueTask(ctx), deps = queueDeps(), spawned: string[] = [];
  const spawn = (_: unknown, id: string) => {spawned.push(id); return process.pid;};
  expect((await runTask(ctx, task.id, deps)).queue?.reason).toBe("machine_memory_pressure");
  // Still critical: the re-check keeps it waiting.
  expect(await drainMachineWaits(ctx, spawn, deps)).toEqual([]);
  expect(readTask(ctx, task.id)?.queue?.reason).toBe("machine_memory_pressure");
  setMachineReaders({pressure: () => 2, load: () => ({avg1: 0, cores: 1})});
  expect(await drainMachineWaits(ctx, spawn, deps)).toEqual([task.id]);
  expect(spawned).toEqual([task.id]);
  expect(readTask(ctx, task.id)).toMatchObject({state: "running", executor: "codex"});
  expect(readTask(ctx, task.id)?.queue).toBeUndefined();
});
test("the re-check refreshes a capacity wait's reason when the machine changes", async () => {
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  const ctx = fakeCtx(), task = queueTask(ctx), s = queueStrategy(); s.execution.local_load_limit = 2;
  const deps = queueDeps(s);
  expect((await runTask(ctx, task.id, deps)).queue?.reason).toBe("machine_memory_pressure");
  setMachineReaders({pressure: () => 1, load: () => ({avg1: 36, cores: 12})});
  expect(await drainMachineWaits(ctx, () => process.pid, deps)).toEqual([]);
  expect(readTask(ctx, task.id)?.queue).toMatchObject({reason: "machine_load", detail: "load 3/core over limit 2", machine: {loadPerCore: 3, loadLimit: 2}});
});
test("queue capacity reports the machine guard for local executors", async () => {
  const {queueCapacity} = await import("../src/tasks/capacity");
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 100, cores: 1})});
  const s = queueStrategy();
  expect(queueCapacity(s, "codex", {byExecutor: {}, byHost: {}, local: 0})).toMatchObject({reason: "machine_memory_pressure", limit: "machine"});
});
test("a retry after a limit keeps running under memory pressure: the guard gates only fresh starts", async () => {
  const ctx = fakeCtx(), task = queueTask(ctx), deps = queueDeps(queueStrategy(true)), base = deps.runAttempt!;
  const launched: string[] = [];
  deps.runAttempt = async (c, cfg, ...rest) => {
    launched.push(cfg.id);
    // Pressure turns critical while the task is already running.
    setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
    if (cfg.id === "codex") return {exec: {code: 1, stdout: "rate limit reached", stderr: "", timedOut: false}, report: "rate limit reached", attempt: {executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 1, timedOut: false, limitHit: true, log: ""}};
    return base(c, cfg, ...rest);
  };
  const result = await runTask(ctx, task.id, deps);
  expect(launched).toEqual(["codex", "cursor"]);
  expect(result.queue).toBeUndefined();
  expect(result.result?.executor).toBe("cursor");
});
test("the re-check skips a full drain while the guard holds tasks for the same reason", async () => {
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  const ctx = fakeCtx(), task = queueTask(ctx), deps = queueDeps();
  expect((await runTask(ctx, task.id, deps)).queue?.reason).toBe("machine_memory_pressure");
  let statusReads = 0;
  const counted = {...deps, computeStatus: (...args: Parameters<NonNullable<typeof deps.computeStatus>>) => { statusReads++; return deps.computeStatus!(...args); }};
  expect(await drainMachineWaits(ctx, () => process.pid, counted)).toEqual([]);
  expect(statusReads).toBe(0);
});
test("a machine wait whose executors are all unavailable drops the stale machine reason", async () => {
  const {blockExecutor} = await import("../src/executors/blocked");
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  const ctx = fakeCtx(), task = queueTask(ctx), deps = queueDeps();
  expect((await runTask(ctx, task.id, deps)).queue?.reason).toBe("machine_memory_pressure");
  blockExecutor(ctx, "codex");
  setMachineReaders({pressure: () => 1, load: () => ({avg1: 0, cores: 1})});
  expect(await drainMachineWaits(ctx, () => process.pid, deps)).toEqual([]);
  expect(readTask(ctx, task.id)?.queue).toMatchObject({reason: "waiting_retry", limit: "machine", detail: "Waiting for an available executor"});
  // Once an executor is usable again while the guard still holds, the machine reason returns.
  const {unblockExecutor} = await import("../src/executors/blocked");
  const {drainQueue} = await import("../src/tasks/drain");
  unblockExecutor(ctx, "codex");
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([]);
  expect(readTask(ctx, task.id)?.queue).toMatchObject({reason: "machine_memory_pressure", detail: "memory pressure critical"});
});
test("a drain-reserved start is still held when pressure rose after the drain admitted it", async () => {
  const ctx = fakeCtx(), task = queueTask(ctx);
  // The drain reserves a task as running before its runner starts.
  updateTask(ctx, task.id, t => {t.state = "running"; t.executor = "codex";});
  setMachineReaders({pressure: () => 4, load: () => ({avg1: 0, cores: 1})});
  expect((await runTask(ctx, task.id, queueDeps())).queue).toMatchObject({reason: "machine_memory_pressure"});
});
