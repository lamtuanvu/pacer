import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveSnapshot as tsSnapshot, liveV2Snapshot as tsV2Snapshot, eventsSince } from "../src/api/events";
import { handleV2 } from "../src/api/http";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import { consolePath, outboxPath } from "../src/link/paths";
import { createTask, updateTask } from "../src/tasks/store";
import { insertMessage } from "../src/messaging/store";
import { updateState } from "../src/discovery/state";
import { writeJsonAtomic } from "../src/fsutil";
import { taskData } from "../src/link/pump";
import { toBudget } from "../src/link/budget";
import { OUTBOX_KEEP, OUTBOX_MAX_BYTES } from "../src/link/store";
import { capacityFixture, record } from "./read-model-helpers";
import { snapshotTasks } from "../src/api/read-model/tasks";
import { buildRustProbe, rustSnapshot, rustRequest, closeRustProbe, readModelCtx as fakeCtx } from "./read-model-rust-helpers";
import type { Ctx } from "../src/types";
import { toV2Event, v3OnlyEvent, V3_CURSOR_BASE } from "../src/api/v2-compat";

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

test("snapshot golden covers populated state, errors, boundaries, and legacy transport", () => {
  const contents = JSON.parse(readFileSync(golden, "utf8"));
  for (const key of ["populated", "populatedV2", "warming", "failedStatus", "cachedStatus", "budgetAge", "taskWindow", "legacyConsole"]) {
    expect(contents).toHaveProperty(key);
  }
});

test("event golden covers exclusions, retention, and cursor limits", () => {
  const contents = JSON.parse(readFileSync(golden, "utf8"));
  for (const key of ["retention", "oversizedOutbox", "cursorBounds", "v2Exclusions"]) {
    expect(contents).toHaveProperty(key);
  }
});

test("SSE polls an external writer and stops after cancellation", async () => {
  const started: unknown[] = [];
  const cleared: unknown[] = [];
  const start = globalThis.setInterval;
  const stop = globalThis.clearInterval;
  const startSpy = spyOn(globalThis, "setInterval").mockImplementation(((...args: Parameters<typeof setInterval>) => {
    const handle = start(...args);
    started.push(handle);
    return handle;
  }) as typeof setInterval);
  const stopSpy = spyOn(globalThis, "clearInterval").mockImplementation(((handle: Parameters<typeof clearInterval>[0]) => {
    cleared.push(handle);
    return stop(handle);
  }) as typeof clearInterval);
  try {
  const ctx = fakeCtx();
  const response = await handleV2(new Request("http://127.0.0.1/v3/events?since=0"), { getCtx: () => ctx, tailMs: 20 });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true, mode: 0o700 });
  writeFileSync(outboxPath(ctx), JSON.stringify({ seq: 1, at: ctx.now, envelope: { type: "config", data: { area: "config", at: ctx.now } } }) + "\n", { mode: 0o600 });
  const frame = await Promise.race([reader.read(), Bun.sleep(1000).then(() => { throw Error("external writer poll timed out"); })]);
  expect(new TextDecoder().decode(frame.value)).toBe(`id: ${V3_CURSOR_BASE + 1}\nevent: config\ndata: {"area":"config","at":${ctx.now}}\n\n`);
  await reader.cancel();
  appendFileSync(outboxPath(ctx), JSON.stringify({ seq: 2, at: ctx.now, envelope: { type: "config", data: { area: "config", at: ctx.now } } }) + "\n");
  await expect(reader.closed).resolves.toBeUndefined();
  expect(started.length).toBeGreaterThanOrEqual(2);
  expect(started.every(handle => cleared.includes(handle))).toBe(true);
  } finally {
    startSpy.mockRestore();
    stopSpy.mockRestore();
  }
});

test("SSE sends the 15-second keepalive and cancellation closes its stream", async () => {
  const ctx = fakeCtx();
  const response = await handleV2(new Request("http://127.0.0.1/v3/events?since=0"), { getCtx: () => ctx, tailMs: 30_000 });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
  const frame = await Promise.race([reader.read(), Bun.sleep(16_000).then(() => { throw Error("keepalive timed out"); })]);
  expect(new TextDecoder().decode(frame.value)).toBe(": keepalive\n\n");
  await reader.cancel();
}, 20_000);

test("outbox retention enforces both entry and byte limits", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, Array.from({ length: OUTBOX_KEEP + 1 }, (_, i) => ({ seq: i + 1, at: ctx.now, envelope: { type: "config" as const, data: { area: "config", at: ctx.now, padding: "x".repeat(1100) } as never } })));
  const lines = readFileSync(outboxPath(ctx), "utf8").trimEnd().split("\n");
  expect(lines.length).toBeLessThanOrEqual(OUTBOX_KEEP);
  // The TS writer's existing rotation retains the last 1000 records even when
  // those records exceed the byte threshold. The Rust port must match it.
  expect(statSync(outboxPath(ctx)).size).toBeGreaterThan(OUTBOX_MAX_BYTES);
});

test("oversized outbox entry is retained by the existing TS writer", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [{ seq: 1, at: ctx.now, envelope: { type: "alert", data: { key: "large", level: "info", title: "x".repeat(OUTBOX_MAX_BYTES), body: "", at: ctx.now } } }]);
  expect(readFileSync(outboxPath(ctx), "utf8").trimEnd().split("\n")).toHaveLength(1);
  expect(statSync(outboxPath(ctx)).size).toBeGreaterThan(OUTBOX_MAX_BYTES);
});

test("seeded v2/v3 event conversion keeps only legacy event families", () => {
  let seed = 0x570;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const families = ["task", "alert", "config", "attention", "notify", "desktop.update", "message", "assistant", "machine", "planner", "discovery.found"];
  const areas = ["machine", "discovery", "strategy", "accounts"];
  const ids = ["discovery:one", "discovery-network:two", "review:three", "setup:four"];
  // Cover every ID and area for the relevant families; a seeded sample alone
  // can miss non-discovery attention and notification IDs.
  for (const type of ["attention", "notify", "config"]) for (const area of areas) for (const id of ids) {
    const event = { seq: V3_CURSOR_BASE + 1, at: 100, type, data: { area, id, key: id } };
    const expected = type === "config" ? area === "discovery" : id.startsWith("discovery");
    expect(v3OnlyEvent(event)).toBe(expected);
    expect(toV2Event(event as never) === null).toBe(type === "config" && ["machine", "discovery"].includes(area));
  }
  for (let i = 0; i < 128; i++) {
    const type = families[next() % families.length]!;
    const area = areas[next() % areas.length]!;
    const id = ids[next() % ids.length]!;
    const event = { seq: V3_CURSOR_BASE + i + 1, at: 100 + i, type, data: { area, id, key: id } };
    const v3Only = type === "discovery.found" || type === "config" && area === "discovery" || ["attention", "notify"].includes(type) && id.startsWith("discovery");
    expect(v3OnlyEvent(event)).toBe(v3Only);
    const excluded = ["desktop.update", "message", "assistant", "machine", "planner", "discovery.found"].includes(type) || type === "config" && ["machine", "discovery"].includes(area);
    const converted = toV2Event(event as never);
    expect(converted === null).toBe(excluded);
    if (converted) expect(converted.seq).toBe(i + 1);
  }
});

test("outbox conversion retains non-discovery attention, notify, and config for v2", () => {
  const ctx = fakeCtx();
  appendOutbox(ctx, [
    { seq: 1, envelope: { type: "entity", data: { kind: "attention", id: "review:one", value: { id: "review:one" } } } },
    { seq: 2, envelope: { type: "entity", data: { kind: "attention", id: "discovery:one", value: { id: "discovery:one" } } } },
    { seq: 3, envelope: { type: "config", data: { area: "strategy", at: ctx.now } } },
    { seq: 4, envelope: { type: "config", data: { area: "discovery", at: ctx.now } } },
    { seq: 5, envelope: { type: "entity", data: { kind: "notify", id: "review:one", value: { key: "review:one" } } } },
    { seq: 6, envelope: { type: "entity", data: { kind: "notify", id: "discovery:one", value: { key: "discovery:one" } } } },
  ]);
  expect(eventsSince(ctx, 0, 2).events.map(e => [e.type, e.seq])).toEqual([["attention", 1], ["config", 3], ["notify", 5]]);
  expect(eventsSince(ctx, 0, 3).events.map(e => [e.type, e.seq])).toEqual([
    ["attention", V3_CURSOR_BASE + 1], ["attention", V3_CURSOR_BASE + 2],
    ["config", V3_CURSOR_BASE + 3], ["config", V3_CURSOR_BASE + 4],
    ["notify", V3_CURSOR_BASE + 5], ["notify", V3_CURSOR_BASE + 6],
  ]);
});

// Golden files are the serialized TS wire contract. Replace only process, platform,
// temporary-home and random identifiers; preserve every other field and ordering.
const golden = join(import.meta.dir, "fixtures", "read-model", "ts-golden.json");
const normalize = (value: unknown, home: string, ids: string[]): unknown => {
  let json = JSON.stringify(value);
  json = json.replaceAll(home, "$HOME");
  json = json.replaceAll(home.split("/").at(-1)!, "FIXTURE_HOME");
  json = json.replace(/local:[0-9a-f]{12}/g, "local:FIXTURE");
  ids.forEach((id, i) => { json = json.replaceAll(id, `TASK_${i + 1}`); });
  json = json.replace(/m-\d{14}-[0-9a-f]{8}/g, "MESSAGE_ID");
  const parsed = JSON.parse(json) as { snapshot?: { service?: Record<string, unknown>; machine?: Record<string, unknown>; console?: Record<string, unknown> } };
  const snapshots = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of snapshots) {
    const s = row?.snapshot;
    if (s?.service) { s.service.pid = 0; s.service.startedAt = 0; }
    if (s?.machine) { s.machine.os = "PLATFORM"; s.machine.arch = "ARCH"; }
    if (s?.console) s.console.pid = 0;
  }
  return parsed;
};

async function checkedSnapshot(ctx: Ctx, options: Parameters<typeof tsSnapshot>[1] = {}, protocol: 2 | 3) {
  const expected = await (protocol === 3 ? tsSnapshot : tsV2Snapshot)(ctx, options);
  const actual = await rustSnapshot(ctx, expected, options, protocol);
  expect(JSON.stringify(normalize(actual, ctx.home, []))).toBe(JSON.stringify(normalize(expected, ctx.home, [])));
  return expected;
}
const liveSnapshot = (ctx: Ctx, options: Parameters<typeof tsSnapshot>[1] = {}) => checkedSnapshot(ctx, options, 3) as ReturnType<typeof tsSnapshot>;
const liveV2Snapshot = (ctx: Ctx, options: Parameters<typeof tsSnapshot>[1] = {}) => checkedSnapshot(ctx, options, 2) as ReturnType<typeof tsV2Snapshot>;

const status = async (ctx: ReturnType<typeof fakeCtx>) => ({ generatedAt: ctx.now, strategy: "default", planner: "codex", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as never;

test("TS full read-model and event/cursor golden over isolated fixture homes", async () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "Asia/Ho_Chi_Minh";
  try {
  const ctx = fakeCtx({ which: () => null, readOnly: true });
  const ids: string[] = [];
  const empty = normalize(await liveSnapshot(ctx, { status }), ctx.home, ids);

  // Old-release transport state is an input to the current v2 adapter. The richer
  // task and message state comes from SQLite, not from this legacy JSON file.
  mkdirSync(join(ctx.pacerHome, "link"), { recursive: true });
  writeJsonAtomic(latestPath(ctx), { v: 1, seq: 7, at: ctx.now - 20,
    mode: { mode: "paused", previous: "normal", strategy: "old-release", at: ctx.now - 20 },
    budget: null, tasks: [], alerts: [{ key: "legacy", level: "warn", title: "Old release", body: "upgrade", at: ctx.now - 20 }], console: null });
  const task = createTask(ctx, { brief: { goal: "Review the read model. Then reply", repo: ctx.home }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
  ids.push(task.id);
  updateTask(ctx, task.id, row => { row.queue = { reason: "paused", since: ctx.now, position: 1 }; });
  insertMessage(ctx, { taskId: task.id, rootId: `task:${task.id}`, from: `task:${task.id}`, to: "human", kind: "question", body: "Which path?", replyTo: null, requestId: null });
  await updateState({ ...ctx, readOnly: false }, state => { state.seen["AAAAAAAAAAAAAAAAAAAAAAAAAA"] = { discoveryId: "AAAAAAAAAAAAAAAAAAAAAAAAAA", name: "studio", version: "1.2", hints: "", network: "test", firstSeen: ctx.now, lastSeen: ctx.now, promptedAt: ctx.now }; });
  const rich = normalize(await liveSnapshot(ctx, { status }), ctx.home, ids);
  const v2 = normalize(await liveV2Snapshot(ctx, { status }), ctx.home, ids);
  await publish({ ...ctx, readOnly: false }, [
    { type: "budget", data: { generatedAt: ctx.now, strategy: "old-release", planner: "codex", mode: "normal", providers: [], ranked: [] } },
    { type: "task", data: taskData(task) },
    { type: "config", data: { area: "strategy", at: ctx.now } },
    { type: "discovery.found", data: { discoveryId: "AAAAAAAAAAAAAAAAAAAAAAAAAA", name: "studio", version: "1.2" } },
    { type: "entity", data: { kind: "attention", id: "discovery:AAAAAAAAAAAAAAAAAAAAAAAAAA", value: { id: "discovery:AAAAAAAAAAAAAAAAAAAAAAAAAA", kind: "discovery" } } },
    { type: "entity", data: { kind: "counts", id: "counts", value: { attention: 2, running: 0 } } },
    { type: "alert", data: { key: "upgrade", level: "info", title: "Upgrade", body: "", at: ctx.now } },
    { type: "entity", data: { kind: "executor", id: "gone", removed: true } },
    { type: "config", data: { area: "discovery", at: ctx.now } },
    { type: "entity", data: { kind: "attention", id: "discovery:AAAAAAAAAAAAAAAAAAAAAAAAAA", removed: true } },
    { type: "entity", data: { kind: "counts", id: "counts", value: { attention: 1, running: 0 } } },
  ]);
  for (const [since, protocol] of [[0,3],[0,2],[1,3],[7,2],[9_007_199_254_740_992,3]] as const) {
    const actual = await rustRequest(ctx, { op: "events", since, protocol });
    expect(JSON.stringify(normalize(actual, ctx.home, ids))).toBe(JSON.stringify(normalize(eventsSince(ctx, since, protocol), ctx.home, ids)));
  }
  const replayLast = eventsSince(ctx, 0, 3).last;
  const eventCases = [
    eventsSince(ctx, 0, 3), eventsSince(ctx, 0, 2),
    eventsSince(ctx, 1, 3), // a pre-v3 cursor forces protocol reset
    eventsSince(ctx, 7, 2), // retained outbox begins after the old-release seq
    eventsSince(ctx, 9_007_199_254_740_992, 3), // current cursor with no newer event
  ].map(row => normalize(row, ctx.home, ids));
  const gapCtx = fakeCtx({ which: () => null });
  appendOutbox(gapCtx, [{ seq: 50, at: gapCtx.now, envelope: { type: "entity", data: { kind: "executor", id: "old", removed: true } } }]);
  expect(await rustRequest(gapCtx, { op: "events", since: 3_000_000_000_010, protocol: 3 })).toEqual(eventsSince(gapCtx, 3_000_000_000_010, 3));
  const gap = normalize(eventsSince(gapCtx, 3_000_000_000_010, 3), gapCtx.home, ids);
  const stream = await handleV2(new Request("http://127.0.0.1/v3/events?since=0"), { getCtx: () => ctx, tailMs: 1000 });
  const reader = stream.body!.getReader();
  let initialFrames = "";
  while (!initialFrames.includes(`id: ${replayLast}\n`)) initialFrames += new TextDecoder().decode((await reader.read()).value);
  await publish({ ...ctx, readOnly: false }, [{ type: "entity", data: { kind: "executor", id: "new", value: { id: "new" } } }]);
  const wakeFrame = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const sse = normalize({ contentType: stream.headers.get("content-type"), cacheControl: stream.headers.get("cache-control"), initialFrames, wakeFrame }, ctx.home, ids);
  const http = await handleV2(new Request("http://127.0.0.1/v3/events?since=-1"), { getCtx: () => ctx });
  const invalidCursor = { status: http.status, body: await http.json() };
  const populatedCtx = fakeCtx({ which: () => null, readOnly: true });
  const fixture = capacityFixture();
  writeJsonAtomic(join(populatedCtx.pacerHome, "fixture.json"), {});
  writeFileSync(join(populatedCtx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\nhosts:\n  devbox:\n    ssh: build-host\n    max_tasks: 2\n", { mode: 0o600 });
  const populatedIds: string[] = [];
  for (const [index, state] of (["running", "done", "failed"] as const).entries()) {
    const itemCtx = { ...populatedCtx, now: populatedCtx.now - index };
    const item = createTask(itemCtx, { brief: { goal: `Fixture ${state}`, repo: populatedCtx.home }, kind: "feature", requestedExecutor: "codex", timeoutS: 60 });
    populatedIds.push(item.id);
    updateTask(itemCtx, item.id, row => {
      row.state = state;
      row.executor = "codex";
      if (state === "done") row.review = { accepted: true, kind: "feature", note: null, at: populatedCtx.now };
    });
  }
  writeJsonAtomic(join(populatedCtx.pacerHome, "state", "pause.json"), { until: populatedCtx.now + 90, reason: "fixture pause", by: "human" });
  writeJsonAtomic(join(populatedCtx.pacerHome, "state", "mode-hold.json"), { mode: "strict", until: populatedCtx.now + 30 });
  writeJsonAtomic(latestPath(populatedCtx), { v: 1, seq: 0, at: populatedCtx.now, budget: toBudget(fixture.st), mode: null, tasks: [], alerts: [], console: null });
  const populated = normalize(await liveSnapshot(populatedCtx, { status: async () => fixture.st }), populatedCtx.home, populatedIds);
  const populatedV2 = normalize(await liveV2Snapshot(populatedCtx, { status: async () => fixture.st }), populatedCtx.home, populatedIds);
  const warming = normalize(await liveSnapshot({ ...populatedCtx, now: populatedCtx.now + 1 }, { status: async () => { throw Error("status is warming up"); } }), populatedCtx.home, populatedIds);
  const failedStatus = normalize(await liveSnapshot({ ...populatedCtx, now: populatedCtx.now + 2 }, { status: async () => { throw Error("status unavailable"); } }), populatedCtx.home, populatedIds);
  const cachedStatus = normalize(await liveSnapshot({ ...populatedCtx, now: populatedCtx.now + 3 }), populatedCtx.home, populatedIds);
  const staleBudget = await liveV2Snapshot({ ...populatedCtx, now: populatedCtx.now + 61 }, { status: async () => { throw Error("status unavailable"); } });
  const refreshedBudget = await liveV2Snapshot({ ...populatedCtx, now: populatedCtx.now + 62 }, { status: async () => ({ ...fixture.st, generatedAt: populatedCtx.now + 62 }) });
  const budgetAge = { stale: staleBudget.snapshot.budget?.generatedAt, refreshed: refreshedBudget.snapshot.budget?.generatedAt };
  const taskRows = [record("running", populatedCtx.now - 3 * 86400), record("done", populatedCtx.now - 86400), record("done", populatedCtx.now - 86400 - 1), record("failed", populatedCtx.now, { dismissed: true }), record("queued", populatedCtx.now)];
  const capRows = Array.from({ length: 205 }, (_, i) => record("queued", populatedCtx.now - i, { id: `cap-${String(i).padStart(3, "0")}` }));
  for (const records of [taskRows, capRows]) {
    const rust = await rustRequest(populatedCtx, { op: "tasks", records });
    expect(rust).toEqual(snapshotTasks(populatedCtx, records));
  }
  const windowRows = snapshotTasks(populatedCtx, taskRows);
  const capped = snapshotTasks(populatedCtx, capRows);
  const taskWindow = { states: windowRows.map(t => t.state), count: capped.length, first: capped[0]?.id, last: capped.at(-1)?.id };
  const console = { handle: "fixture", paneKey: "pane", pid: process.pid, startedAt: ctx.now - 20, heartbeatAt: ctx.now };
  writeJsonAtomic(consolePath(ctx), console);
  const legacyConsole = (normalize(await liveV2Snapshot(ctx, { status }), ctx.home, ids) as {snapshot:{console:unknown}}).snapshot.console;
  const retentionCtx = fakeCtx();
  appendOutbox(retentionCtx, Array.from({ length: 1001 }, (_, i) => ({ seq: i + 1, at: retentionCtx.now, envelope: { type: "config" as const, data: { area: "config", at: retentionCtx.now } } })));
  const retention = { size: statSync(outboxPath(retentionCtx)).size, events: eventsSince(retentionCtx, 1, 3).events.length, reset: eventsSince(retentionCtx, 1, 3).reset, first: eventsSince(retentionCtx, 1, 3).events[0]?.seq };
  const oversizedCtx = fakeCtx();
  appendOutbox(oversizedCtx, [{ seq: 1, at: oversizedCtx.now, envelope: { type: "alert", data: { key: "large", level: "info", title: "x".repeat(OUTBOX_MAX_BYTES), body: "", at: oversizedCtx.now } } }]);
  const oversizedOutbox = { entries: readFileSync(outboxPath(oversizedCtx), "utf8").trimEnd().split("\n").length, overLimit: statSync(outboxPath(oversizedCtx)).size > OUTBOX_MAX_BYTES };
  const cursorBounds = [];
  for (const since of ["0", String(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER + 1), "1.2", "NaN", "-1"]) {
    const response = await handleV2(new Request(`http://127.0.0.1/v3/events?since=${since}`), { getCtx: () => ctx });
    if (response.status === 200) {
      const cursorReader = response.body!.getReader();
      cursorBounds.push({ since, status: response.status, first: new TextDecoder().decode((await cursorReader.read()).value) });
      await cursorReader.cancel();
    } else cursorBounds.push({ since, status: response.status, body: await response.json() });
  }
  const types = ["discovery.found", "config", "attention", "notify", "desktop.update", "message", "assistant", "machine", "planner", "task"];
  const v2Exclusions = types.flatMap(type => ["discovery:sample", "review:sample"].flatMap(id => ["discovery", "strategy", "machine"].map(area => ({ type, id, area, discovery: v3OnlyEvent({ type, data: { area, id, key: id } }), v2: toV2Event({ seq: V3_CURSOR_BASE + 1, at: ctx.now, type, data: { area, id, key: id } } as never) }))));
  const observed = { empty, rich, v2, eventCases, gap, sse, invalidCursor, populated, populatedV2, warming, failedStatus, cachedStatus, budgetAge, taskWindow, legacyConsole, retention, oversizedOutbox, cursorBounds, v2Exclusions };
  if (process.env.UPDATE_READ_MODEL_GOLDEN === "1") {
    mkdirSync(join(import.meta.dir, "fixtures", "read-model"), { recursive: true });
    writeFileSync(golden, JSON.stringify(observed, null, 2) + "\n");
  }
  expect(observed).toEqual(JSON.parse(readFileSync(golden, "utf8")));
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
}, 120_000);
