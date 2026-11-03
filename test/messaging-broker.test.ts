import { expect, spyOn, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { brokerTick } from "../src/messaging/broker";
import { getLiveness } from "../src/messaging/liveness-store";
import { byRequest, insertMessage, markRead } from "../src/messaging/store";
import { apiTask } from "../src/api/read-model/tasks";
import { deriveItems } from "../src/attention/rules";
import { startServer } from "../src/serve/http";
import { withLock } from "../src/core/lock";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fixture() {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "done"; t.origin = "external:planner"; });
  const message = insertMessage(ctx, { taskId: task.id, rootId: `task:${task.id}`, from: "external:planner", to: `task:${task.id}`, kind: "message", body: "continue", replyTo: null, requestId: "first" }).message;
  return { ctx, id: task.id, message };
}
const mode = async () => "normal" as const;

test("a pending message to a settled task is retried through the normal turn admission path", async () => {
  const { ctx, id } = fixture();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  updateTask(ctx, id, t => {
    t.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: tmpDir(), logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
    t.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    t.result = { status: "done", executor: "codex", model: null, files: "", report: "done", backend: "direct" };
  });
  const spawned: string[] = [];
  await brokerTick(ctx, { mode, spawnRunner: (_c, task) => { spawned.push(task); return 1; } });
  expect(spawned).toEqual([id]);
  expect(readTask(ctx, id)?.pendingTurn).toBeDefined();
});

test("refused delivery is stalled and appears in attention; clearing resolves it", async () => {
  const { ctx, id, message } = fixture();
  await brokerTick(ctx, { mode });
  expect(getLiveness(ctx, `task:${id}`)?.stalledAt).toBe(ctx.now);
  const task = apiTask(ctx, readTask(ctx, id)!);
  expect(task.liveness?.stalled).toBe(true);
  const items = deriveItems({ now: ctx.now, tasks: [task], executors: [], accounts: [], planner: null,
    setup: { items: [] } as never, update: null, retryTarget: () => null });
  expect(items.some(i => i.kind === "stalled" && i.taskId === id)).toBe(true);
  markRead(ctx, `task:${id}`, [message.id]);
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  expect(getLiveness(ctx, `task:${id}`)).toBeNull();
});

test("external unread messages escalate after the configured delay", async () => {
  const { ctx, id, message } = fixture();
  markRead(ctx, `task:${id}`, [message.id]);
  markRead(ctx, `task:${id}`, [insertMessage(ctx, { taskId: id, rootId: `task:${id}`, from: "external:planner", to: `task:${id}`, kind: "message", body: "other", replyTo: null, requestId: "other" }).message.id]);
  insertMessage(ctx, { taskId: id, rootId: `task:${id}`, from: `task:${id}`, to: "external:planner", kind: "report", body: "done", replyTo: null, requestId: "report" });
  await brokerTick(ctx, { mode });
  expect(getLiveness(ctx, "external:planner")?.escalatedAt).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 901 }, { mode });
  expect(getLiveness(ctx, "external:planner")?.escalatedAt).toBe(ctx.now + 901);
});

test("strict mode escalates a refused delivery without starting a turn", async () => {
  const { ctx, id } = fixture();
  const spawned: string[] = [];
  await brokerTick(ctx, { mode: async () => "strict", spawnRunner: (_c, task) => { spawned.push(task); return 1; } });
  expect(spawned).toEqual([]);
  expect(getLiveness(ctx, `task:${id}`)?.stalledAt).toBe(ctx.now);
});

test("cycle nudges the deepest task with exponential backoff and clears after an answer", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const a = createTask(ctx, { brief: { goal: "a", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const b = createTask(ctx, { brief: { goal: "b", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, a.id, t => { t.state = "done"; });
  updateTask(ctx, b.id, t => { t.state = "done"; });
  const qa = insertMessage(ctx, { taskId: a.id, rootId: `task:${a.id}`, from: `task:${a.id}`, to: `task:${b.id}`, kind: "question", body: "A?", replyTo: null, requestId: "qa" }).message;
  const qb = insertMessage(ctx, { taskId: b.id, rootId: `task:${b.id}`, from: `task:${b.id}`, to: `task:${a.id}`, kind: "question", body: "B?", replyTo: null, requestId: "qb" }).message;
  await brokerTick(ctx, { mode });
  expect([a.id, b.id].some(id => byRequest(ctx, "broker", `nudge:task:${id}:1`))).toBe(false);
  await brokerTick({ ...ctx, now: ctx.now + 59 }, { mode });
  expect([a.id, b.id].some(id => byRequest(ctx, "broker", `nudge:task:${id}:1`))).toBe(false);
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  const target = [a.id, b.id].find(id => byRequest(ctx, "broker", `nudge:task:${id}:1`))!;
  expect(target).toBeDefined();
  const node = `task:${target}`;
  expect(getLiveness(ctx, node)?.attempts).toBe(1);
  await brokerTick({ ...ctx, now: ctx.now + 179 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:2`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 180 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:2`)).not.toBeNull();
  const ownQuestion = target === a.id ? qa : qb;
  insertMessage(ctx, { taskId: target, rootId: node, from: node, to: ownQuestion.to,
    kind: "answer", body: "answered", replyTo: target === a.id ? qb.id : qa.id, requestId: "answer" });
  markRead(ctx, node, [target === a.id ? qb.id : qa.id]);
  await brokerTick({ ...ctx, now: ctx.now + 181 }, { mode });
  expect(getLiveness(ctx, node)?.reason).not.toBe("cycle");
});

function cycle(ctx: ReturnType<typeof fakeCtx>) {
  const a = createTask(ctx, { brief: { goal: "a", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const b = createTask(ctx, { brief: { goal: "b", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, a.id, t => { t.state = "done"; });
  updateTask(ctx, b.id, t => { t.state = "done"; });
  insertMessage(ctx, { taskId: a.id, rootId: `task:${a.id}`, from: `task:${a.id}`, to: `task:${b.id}`, kind: "question", body: "A?", replyTo: null, requestId: "qa" });
  insertMessage(ctx, { taskId: b.id, rootId: `task:${b.id}`, from: `task:${b.id}`, to: `task:${a.id}`, kind: "question", body: "B?", replyTo: null, requestId: "qb" });
  return [a.id, b.id];
}

test("zero nudge cap escalates a cycle immediately without inserting a nudge", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nmessaging:\n  liveness: {max_nudges: 0}\n");
  const ids = cycle(ctx);
  await brokerTick(ctx, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
  expect(ids.some(id => byRequest(ctx, "broker", `nudge:task:${id}:1`))).toBe(false);
  expect(ids.map(id => getLiveness(ctx, `task:${id}`))).toContainEqual(expect.objectContaining({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now }));
});

test("a cycle stops at max_nudges on the third nudge and the fourth tick inserts nothing", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const ids = cycle(ctx);
  for (const at of [0, 60, 180, 420, 900, 1800]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
  const target = ids.find(id => byRequest(ctx, "broker", `nudge:task:${id}:1`))!;
  const node = `task:${target}`;
  expect(byRequest(ctx, "broker", `nudge:${node}:3`)).not.toBeNull();
  expect(byRequest(ctx, "broker", `nudge:${node}:4`)).toBeNull();
  expect(getLiveness(ctx, node)).toMatchObject({ nudges: 3, stalledAt: ctx.now + 420, escalatedAt: ctx.now + 420 });
});

test("zero nudge cap escalates an idle run immediately without inserting a nudge", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nmessaging:\n  liveness: {max_nudges: 0}\n");
  const task = createTask(ctx, { brief: { goal: "idle", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.progress = { phase: "idle", lastOutputAt: ctx.now - 500 } as typeof t.progress; });
  await brokerTick(ctx, { mode });
  const node = `task:${task.id}`;
  expect(getLiveness(ctx, node)).toMatchObject({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now });
  expect(byRequest(ctx, "broker", `nudge:${node}:1`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
  expect(getLiveness(ctx, node)?.nudges).toBe(0);
});

test("idle run waits one interval before bounded recovery", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = createTask(ctx, { brief: { goal: "idle", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.progress = { phase: "idle", lastOutputAt: ctx.now - 500 } as typeof t.progress; });
  const node = `task:${task.id}`;
  await brokerTick(ctx, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:1`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:1`)).not.toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 180 }, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 420 }, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:4`)).toBeNull();
  expect(getLiveness(ctx, node)).toMatchObject({ nudges: 3, stalledAt: ctx.now + 420, escalatedAt: ctx.now + 420 });
});

test("a concurrent broker tick skips the held lock", async () => {
  const { ctx } = fixture();
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = withLock(ctx, "msg-broker", async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready;
  try { expect(await brokerTick(ctx, { mode })).toEqual({ skipped: "locked" }); }
  finally { release(); await held; }
});

test("broker timer is registered at 15 seconds and cleared on stop", async () => {
  const ctx = fakeCtx({ which: () => null });
  const real = globalThis.setInterval;
  let timer: ReturnType<typeof setInterval> | undefined;
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    const id = real(fn, ms);
    if (ms === 15_000) timer = id;
    return id;
  }) as typeof setInterval);
  const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  intervals.mockRestore();
  const cleared = spyOn(globalThis, "clearInterval");
  try {
    expect(timer).toBeDefined();
    await server.stop();
    expect(cleared.mock.calls.some(([id]) => id === timer)).toBe(true);
  } finally { cleared.mockRestore(); await server.stop(); }
});

test("strict mode escalates an idle run instead of nudging it", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = createTask(ctx, { brief: { goal: "idle", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.progress = { phase: "idle", lastOutputAt: ctx.now - 500 } as typeof t.progress; });
  const node = `task:${task.id}`;
  await brokerTick(ctx, { mode: async () => "strict" as const });
  expect(byRequest(ctx, "broker", `nudge:${node}:1`)).toBeNull();
  expect(getLiveness(ctx, node)).toMatchObject({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now });
});
