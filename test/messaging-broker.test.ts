import { expect, spyOn, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { brokerTick, type BrokerDeps } from "../src/messaging/broker";
import type { CallerReach } from "../src/messaging/caller-reach";
import * as callerReach from "../src/messaging/caller-reach";
import { getLiveness } from "../src/messaging/liveness-store";
import { byRequest, insertMessage, markRead, messagesDatabase } from "../src/messaging/store";
import { ownProcessIdentity } from "../src/update/desktop/process-identity";
import type { Ctx } from "../src/types";
import * as runs from "../src/supervisor/run";
import * as turns from "../src/messaging/turns";
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
  expect([a.id, b.id].some(id => byRequest(ctx, "broker", `nudge:task:${id}:a0:1`))).toBe(false);
  await brokerTick({ ...ctx, now: ctx.now + 59 }, { mode });
  expect([a.id, b.id].some(id => byRequest(ctx, "broker", `nudge:task:${id}:a0:1`))).toBe(false);
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  const target = [a.id, b.id].find(id => byRequest(ctx, "broker", `nudge:task:${id}:a0:1`))!;
  expect(target).toBeDefined();
  const node = `task:${target}`;
  expect(getLiveness(ctx, node)?.attempts).toBe(1);
  await brokerTick({ ...ctx, now: ctx.now + 179 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:2`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 180 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:2`)).not.toBeNull();
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
  expect(ids.some(id => byRequest(ctx, "broker", `nudge:task:${id}:a0:1`))).toBe(false);
  expect(ids.map(id => getLiveness(ctx, `task:${id}`))).toContainEqual(expect.objectContaining({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now }));
});

test("a cycle stops at max_nudges on the third nudge and the fourth tick inserts nothing", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const ids = cycle(ctx);
  for (const at of [0, 60, 180, 420, 900, 1800]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
  const target = ids.find(id => byRequest(ctx, "broker", `nudge:task:${id}:a0:1`))!;
  const node = `task:${target}`;
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:3`)).not.toBeNull();
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:4`)).toBeNull();
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
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:1`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
  expect(getLiveness(ctx, node)?.nudges).toBe(0);
});

test("idle run waits one interval before bounded recovery", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = createTask(ctx, { brief: { goal: "idle", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.progress = { phase: "idle", lastOutputAt: ctx.now - 500 } as typeof t.progress; });
  const node = `task:${task.id}`;
  await brokerTick(ctx, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:1`)).toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:1`)).not.toBeNull();
  await brokerTick({ ...ctx, now: ctx.now + 180 }, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 420 }, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:4`)).toBeNull();
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
  expect(byRequest(ctx, "broker", `nudge:${node}:a0:1`)).toBeNull();
  expect(getLiveness(ctx, node)).toMatchObject({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now });
});

test("spinner output does not reset a no_progress stall", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = createTask(ctx, { brief: { goal: "spin", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const spin = (at: number) => updateTask(ctx, task.id, t => {
    t.state = "running"; t.attemptStartedAt = ctx.now - 3600;
    t.progress = { phase: "working", lastOutputAt: at, lastChangeAt: ctx.now - 3600, gitObserved: true } as typeof t.progress;
  });
  const node = `task:${task.id}`;
  spin(ctx.now - 1);
  await brokerTick(ctx, { mode });
  const first = getLiveness(ctx, node);
  expect(first).toMatchObject({ reason: "no_progress", since: ctx.now - 3600, nudges: 0 });
  spin(ctx.now + 14);
  await brokerTick({ ...ctx, now: ctx.now + 15 }, { mode });
  expect(getLiveness(ctx, node)).toMatchObject({ reason: "no_progress", since: first!.since, nudges: first!.nudges, progressMark: first!.progressMark });
});

/** A running executor whose output never becomes progress, with the run the broker would stop. */
function spinning(ctx: ReturnType<typeof fakeCtx>, goal: string) {
  const task = createTask(ctx, { brief: { goal, repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  const dir = tmpDir();
  updateTask(ctx, task.id, t => {
    t.state = "running"; t.attemptStartedAt = ctx.now - 3600;
    t.progress = { phase: "working", lastOutputAt: ctx.now - 1, lastChangeAt: ctx.now - 3600, gitObserved: true } as typeof t.progress;
    t.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now - 3600, mode: "current", workdir: task.brief.repo, logFile: "/dev/null" };
  });
  return { id: task.id, node: `task:${task.id}`, dir };
}
const attention = (ctx: ReturnType<typeof fakeCtx>, id: string, now: number) => deriveItems({ now, tasks: [apiTask(ctx, readTask(ctx, id)!)],
  executors: [], accounts: [], planner: null, setup: { items: [] } as never, update: null, retryTarget: () => null });

test("no_progress pings the executor through delivery with the exact body", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { node } = spinning(ctx, "spin");
  const deliverPing = spyOn(turns, "deliver").mockResolvedValue({ delivery: "turn_started" });
  try {
    await brokerTick(ctx, { mode });
    await brokerTick({ ...ctx, now: ctx.now + 59 }, { mode });
    expect(byRequest(ctx, "broker", `nudge:${node}:a1:1`)).toBeNull();
    await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
    const ping = byRequest(ctx, "broker", `nudge:${node}:a1:1`);
    expect(ping).toMatchObject({ to: node, kind: "nudge",
      body: "pacer: no progress for 30 min. Report progress, ask your parent, or report a blocker." });
    expect(deliverPing.mock.calls.some(([, to]) => to === node)).toBe(true);
    expect(getLiveness(ctx, node)).toMatchObject({ reason: "no_progress", nudges: 1, stalledAt: null });
  } finally { deliverPing.mockRestore(); }
});

test("an outgoing message after the ping clears the no_progress stall", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { id, node } = spinning(ctx, "spin");
  await brokerTick(ctx, { mode });
  await brokerTick({ ...ctx, now: ctx.now + 60 }, { mode });
  expect(getLiveness(ctx, node)).toMatchObject({ reason: "no_progress", nudges: 1 });
  insertMessage(ctx, { taskId: id, rootId: node, from: node, to: "external:planner", kind: "report",
    body: "made progress", replyTo: null, requestId: "progress" });
  await brokerTick({ ...ctx, now: ctx.now + 61 }, { mode });
  expect(getLiveness(ctx, node)).toBeNull();
});

test("three unanswered pings stop the run and the task moves", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { id, node, dir } = spinning(ctx, "spin");
  const stop = spyOn(runs, "stopRun").mockResolvedValue({ code: 143, killed: false });
  try {
    for (const at of [0, 60, 180, 420, 900]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
    expect(byRequest(ctx, "broker", `nudge:${node}:a1:3`)).not.toBeNull();
    expect(byRequest(ctx, "broker", `nudge:${node}:a1:4`)).toBeNull();
    expect(stop.mock.calls).toEqual([[dir]]);
    expect(readTask(ctx, id)?.unresponsive).toEqual({ attempt: 1, pings: 3 });
    expect(getLiveness(ctx, node)).toMatchObject({ nudges: 3, stalledAt: ctx.now + 420, escalatedAt: ctx.now + 420 });
    expect(attention(ctx, id, ctx.now + 900).find(i => i.kind === "stalled"))
      .toMatchObject({ taskId: id, detail: "No progress for 75 min" });
  } finally { stop.mockRestore(); }
});

test("a run replaced after the last ping is neither marked nor stopped", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { id, node, dir } = spinning(ctx, "spin");
  const stop = spyOn(runs, "stopRun").mockResolvedValue({ code: 143, killed: false });
  try {
    for (const at of [0, 60, 180, 420]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
    expect(byRequest(ctx, "broker", `nudge:${node}:a1:3`)).not.toBeNull();
    // The stalled attempt ended on its own and the next attempt started before the stop was due.
    updateTask(ctx, id, t => { t.attemptStartedAt = ctx.now + 800; t.run = { ...t.run!, dir: `${dir}-2`, attempt: 2, startedAt: ctx.now + 800 }; });
    await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode });
    expect(stop.mock.calls).toEqual([]);
    expect(readTask(ctx, id)?.unresponsive).toBeUndefined();
  } finally { stop.mockRestore(); }
});

test("a retried attempt gets its own no_progress pings and stopped pings never resume the task", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { id, node, dir } = spinning(ctx, "spin");
  const stop = spyOn(runs, "stopRun").mockResolvedValue({ code: 143, killed: false });
  try {
    for (const at of [0, 60, 180, 420, 900]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
    expect(stop.mock.calls).toEqual([[dir]]);
    // The stopped attempt's pings are read, so they cannot start a message turn on the task.
    const unread = messagesDatabase(ctx).query<{ n: number }, [string]>(
      "SELECT count(*) n FROM messages WHERE recipient=? AND kind='nudge' AND status<>'read'").get(node)!.n;
    expect(unread).toBe(0);
    // Attempt 2 starts and also makes no progress: it is pinged under its own ids.
    const later = ctx.now + 900;
    updateTask(ctx, id, t => {
      t.attemptStartedAt = later - 3600; t.run = { ...t.run!, dir: `${dir}-2`, attempt: 2, startedAt: later - 3600 };
    });
    for (const at of [960, 1020]) await brokerTick({ ...ctx, now: ctx.now + at }, { mode });
    expect(byRequest(ctx, "broker", `nudge:${node}:a2:1`)).not.toBeNull();
  } finally { stop.mockRestore(); }
});

test("strict mode escalates a no_progress stall instead of pinging it", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const { id, node } = spinning(ctx, "spin");
  const stop = spyOn(runs, "stopRun").mockResolvedValue({ code: 143, killed: false });
  try {
    await brokerTick(ctx, { mode: async () => "strict" });
    expect(byRequest(ctx, "broker", `nudge:${node}:a1:1`)).toBeNull();
    expect(stop.mock.calls).toEqual([]);
    expect(getLiveness(ctx, node)).toMatchObject({ nudges: 0, stalledAt: ctx.now, escalatedAt: ctx.now });
    expect(attention(ctx, id, ctx.now).some(i => i.kind === "stalled" && i.taskId === id)).toBe(true);
  } finally { stop.mockRestore(); }
});

const callerMode = async () => "normal" as const;

function callerTask(ctx: ReturnType<typeof fakeCtx>, origin = "external:claude-code:s1", terminalKind = "orca") {
  const task = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, task.id, t => {
    t.state = "done";
    t.origin = origin;
    if (origin !== "human") {
      t.callerReach = { participant: origin, session: "s1", cwd: tmpDir(), terminal: { kind: terminalKind as "orca", handle: "term_x" }, at: ctx.now } as CallerReach;
      if (terminalKind !== "orca") (t.callerReach!.terminal as { kind: string }).kind = terminalKind;
    }
  });
  return task;
}

test("hooks first: no wake before caller_wake_after_s", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  callerTask(ctx);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  const calls: string[] = [];
  const callerWake = async (_c: any, _r: any, text: string) => { calls.push(text); return "sent" as const; };
  try {
    await brokerTick(ctx, { mode: callerMode, callerWake });
    await brokerTick({ ...ctx, now: ctx.now + 299 }, { mode: callerMode, callerWake });
    expect(calls).toHaveLength(0);
    expect(aliveSpy).not.toHaveBeenCalled();
  } finally { aliveSpy.mockRestore(); }
});

test("pings an open Orca caller after the wake delay", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = callerTask(ctx);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  const calls: string[] = [];
  const callerWake = async (_c: any, _r: any, text: string) => { calls.push(text); return "sent" as const; };
  try {
    await brokerTick(ctx, { mode: callerMode, callerWake });
    await brokerTick({ ...ctx, now: ctx.now + 300 }, { mode: callerMode, callerWake });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`pacer: task ${task.id} is done. Review and decide: pacer review ${task.id} --accept|--reject, or pacer msg inbox.`);
    expect(getLiveness(ctx, "external:claude-code:s1")?.nudges).toBe(1);
  } finally { aliveSpy.mockRestore(); }
});

test("a busy terminal is retried next tick without spending a wake", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  callerTask(ctx);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  let wakeCount = 0;
  const callerWake = async () => { wakeCount++; return "busy" as const; };
  try {
    await brokerTick(ctx, { mode: callerMode, callerWake });
    await brokerTick({ ...ctx, now: ctx.now + 300 }, { mode: callerMode, callerWake });
    expect(getLiveness(ctx, "external:claude-code:s1")?.nudges).toBe(0);
    const before = wakeCount;
    await brokerTick({ ...ctx, now: ctx.now + 300 }, { mode: callerMode, callerWake });
    expect(wakeCount).toBe(before + 1);
  } finally { aliveSpy.mockRestore(); }
});

test("an uncontrolled or unknown caller is not woken and is notified after escalate_after_s", async () => {
  {
    const ctx = fakeCtx({ now: 1_000_000 });
    callerTask(ctx, "external:claude-code:s1", "uncontrolled");
    const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
    const calls: string[] = [];
    const callerWake = async () => { calls.push("wake"); return "sent" as const; };
    try {
      await brokerTick(ctx, { mode: callerMode, callerWake });
      await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode: callerMode, callerWake });
      expect(calls).toHaveLength(0);
      expect(getLiveness(ctx, "external:claude-code:s1")?.stalledAt).toBe(1_000_900);
      expect(getLiveness(ctx, "external:claude-code:s1")?.escalatedAt).toBe(1_000_900);
    } finally { aliveSpy.mockRestore(); }
  }
  {
    const ctx = fakeCtx({ now: 1_000_000 });
    callerTask(ctx);
    const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("unknown");
    const calls: string[] = [];
    const callerWake = async () => { calls.push("wake"); return "sent" as const; };
    try {
      await brokerTick(ctx, { mode: callerMode, callerWake });
      await brokerTick({ ...ctx, now: ctx.now + 900 }, { mode: callerMode, callerWake });
      expect(calls).toHaveLength(0);
      expect(getLiveness(ctx, "external:claude-code:s1")?.stalledAt).toBe(1_000_900);
      expect(getLiveness(ctx, "external:claude-code:s1")?.escalatedAt).toBe(1_000_900);
    } finally { aliveSpy.mockRestore(); }
  }
});

test("a decision clears the ladder", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  const task = callerTask(ctx);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  const callerWake = async () => "sent" as const;
  try {
    await brokerTick(ctx, { mode: callerMode, callerWake });
    await brokerTick({ ...ctx, now: ctx.now + 300 }, { mode: callerMode, callerWake });
    updateTask(ctx, task.id, t => { t.review = { accepted: true, kind: null, note: null, at: ctx.now + 300 }; });
    await brokerTick({ ...ctx, now: ctx.now + 301 }, { mode: callerMode, callerWake });
    expect(getLiveness(ctx, "external:claude-code:s1")).toBeNull();
  } finally { aliveSpy.mockRestore(); }
});

test("strict mode notifies only", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  callerTask(ctx);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  const calls: string[] = [];
  const callerWake = async () => { calls.push("wake"); return "sent" as const; };
  try {
    await brokerTick(ctx, { mode: async () => "strict" as const, callerWake });
    expect(calls).toHaveLength(0);
    expect(aliveSpy).not.toHaveBeenCalled();
    expect(getLiveness(ctx, "external:claude-code:s1")?.escalatedAt).toBe(ctx.now);
  } finally { aliveSpy.mockRestore(); }
});

test("a human origin is only notified", async () => {
  const ctx = fakeCtx({ now: 1_000_000 });
  callerTask(ctx, "human");
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("alive");
  const calls: string[] = [];
  const callerWake = async () => { calls.push("wake"); return "sent" as const; };
  try {
    await brokerTick(ctx, { mode: callerMode, callerWake });
    expect(calls).toHaveLength(0);
    expect(aliveSpy).not.toHaveBeenCalled();
  } finally { aliveSpy.mockRestore(); }
});
