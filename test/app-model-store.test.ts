import { expect, test, spyOn } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { initialState, reduceStore, createStore, type StoreState } from "../app/src/data/store";
import { ApiError, createApi } from "../app/src/data/api";

const snapshot = { ...emptySnapshot(), seq: 5 };
test("snapshot and events reduce without mutating previous state or regressing sequence", () => {
  const start = reduceStore(initialState(), { type: "snapshot", snapshot });
  const event = { seq: 6, at: 123, type: "task" as const, data: { id: "t1", goal: "Work", state: "running", executor: null, backend: null, worktree: null, updatedAt: 123 } };
  const next = reduceStore(start, { type: "event", event });
  expect(next.snapshot?.tasks[0]?.id).toBe("t1");
  expect(next.snapshot?.seq).toBe(6);
  expect(start.snapshot?.tasks).toEqual([]);
  expect(reduceStore(next, { type: "event", event })).toBe(next);
});

test("machine event leaves the app state intact and later task events still apply", () => {
  const start = reduceStore(initialState(), { type: "snapshot", snapshot });
  const machine = reduceStore(start, { type: "event", event: { seq: 6, at: 123, type: "machine", data: { id: "machine-1", label: "Local" } } });
  expect(machine).toBe(start);
  expect(machine.needsSnapshot).toBe(false);
  const task = reduceStore(machine, { type: "event", event: { seq: 7, at: 124, type: "task", data: { id: "t2", goal: "After rotate", state: "running", executor: null, backend: null, worktree: null, updatedAt: 124 } } });
  expect(task.snapshot?.tasks[0]?.id).toBe("t2");
  expect(task.snapshot?.seq).toBe(7);
});

test("reset and reconnect require a snapshot; errors retain content; config invalidates its area and refreshes snapshot capacity", () => {
  const start = reduceStore(initialState(), { type: "snapshot", snapshot });
  const config = reduceStore(start, { type: "event", event: { seq: 6, at: 1, type: "config", data: { area: "accounts", at: 1 } } });
  expect(config.invalidations).toEqual({ accounts: 1 });
  expect(config.snapshot?.seq).toBe(6);
  expect(config.needsSnapshot).toBe(true);
  const offline = reduceStore(config, { type: "disconnected" });
  expect(offline.snapshot).toBe(config.snapshot);
  expect(offline.connected).toBe(false);
  expect(reduceStore(offline, { type: "reconnected" }).needsSnapshot).toBe(true);
  expect(reduceStore(config, { type: "event", event: { seq: 0, at: 2, type: "reset", data: {} } }).needsSnapshot).toBe(true);
  expect(reduceStore(config, { type: "session-ended" }).sessionEnded).toBe(true);
});

test("browser API uses cookie credentials and typed operation errors", async () => {
  const calls: RequestInit[] = [];
  const mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
    if (String(_url).endsWith("/hello")) return Response.json({ protocol: "3.0.0", pacer: "0.2.3", ops: [], events: [] });
    calls.push(init!);
    return Response.json({ error: { code: "invalid_input", message: "Bad name", hint: "Choose a name" } }, { status: 400 });
  }) as unknown as typeof fetch);
  try {
    await expect(createApi().call("config.set", { key: "planner" })).rejects.toMatchObject({ code: "invalid_input", message: "Bad name", hint: "Choose a name" });
    expect(calls[0]?.credentials).toBe("same-origin");
    expect(new Headers(calls[0]?.headers).get("X-Pacer-Client")).toBe("app");
    expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json");
    // Each window names its own client instance, so two windows contend for a lane's driving lease.
    const window = new Headers(calls[0]?.headers).get("X-Pacer-Client-Instance");
    expect(window).toMatch(/^[0-9a-f-]{36}$/);
    await expect(createApi().call("config.set", { key: "planner" })).rejects.toBeInstanceOf(ApiError);
    expect(new Headers(calls[1]?.headers).get("X-Pacer-Client-Instance")).not.toBe(window);
    mock.mockImplementation((async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch);
    await expect(createApi().hello()).rejects.toBeInstanceOf(ApiError);
    await expect(createApi().hello()).rejects.toMatchObject({ status: 401 });
  } finally { mock.mockRestore(); }
});

class FakeEvents {
  static instances: FakeEvents[] = [];
  listeners: Record<string, (event: { data: string; lastEventId: string }) => void> = {};
  closed = false;
  constructor(readonly url: string) { FakeEvents.instances.push(this); }
  addEventListener(type: string, callback: any) { this.listeners[type] = callback; }
  close() { this.closed = true; }
  emit(type: string, data = {}, seq = "6") { this.listeners[type]?.({ data: JSON.stringify(data), lastEventId: seq }); }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
test("v3 stream receives machine and continues applying task events", async () => {
  FakeEvents.instances = [];
  const api = {
    hello: async () => hello("3.0.0", ["machine", "task", "attention"]),
    snapshot: async () => ({ protocol: "3.0.0", seq: 5, snapshot }),
    call: async <T>() => ({} as T),
  };
  const store = createStore(api, FakeEvents as any);
  const stop = store.start();
  try {
    await flush();
    const stream = FakeEvents.instances[0]!;
    expect(stream.url).toBe("/v3/events?since=5");
    stream.emit("open");
    const before = store.getState();
    stream.emit("machine", { event: "rotated", oldId: "old", newId: "new" }, "6");
    expect(store.getState()).toBe(before);
    expect(store.getState().connected).toBe(true);
    stream.emit("task", { id: "after", goal: "After rotate", state: "running", executor: null, backend: null, worktree: null, updatedAt: 7 }, "7");
    expect(store.getState().snapshot?.tasks[0]?.id).toBe("after");
    expect(store.getState().snapshot?.seq).toBe(7);
  } finally { stop(); }
});
test("live store snapshots before streaming and refetches on reset and reconnect", async () => {
  FakeEvents.instances = [];
  let reads = 0;
  const api = { hello: async () => ({ pacer: "1.0.0", protocol: "2.0.0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: 5 + reads, snapshot: { ...snapshot, seq: 5 + reads++ } }), call: async <T>() => ({} as T) };
  const store = createStore(api, FakeEvents as any);
  const stop = store.start();
  await flush();
  expect(store.getState().snapshot?.tasks).toEqual([]);
  FakeEvents.instances[0]!.emit("task", { id: "live", goal: "Live title", state: "running", executor: "codex", backend: null, worktree: null, updatedAt: 6 }, "6");
  FakeEvents.instances[0]!.emit("task", { id: "live", goal: "Live title", state: "done", executor: "codex", backend: null, worktree: null, updatedAt: 7 }, "7");
  expect(store.getState().snapshot?.tasks[0]).toMatchObject({goal:"Live title",state:"done"});
  expect(FakeEvents.instances[0]?.url).toBe("/v2/events?since=5");
  FakeEvents.instances[0]!.emit("open");
  FakeEvents.instances[0]!.emit("error");
  expect(store.getState().connected).toBe(false);
  FakeEvents.instances[0]!.emit("open");
  await flush();
  expect(reads).toBe(2);
  FakeEvents.instances.at(-1)!.emit("reset");
  await flush();
  expect(reads).toBe(3);
  stop();
  expect(FakeEvents.instances.every(s => s.closed)).toBe(true);
});

// Protocol 2.1 read model (UI implementation plan, Phase 0 Task 5).
import fixture from "./fixtures/ui/snapshot.json";
import type { ClientSnapshot as SnapshotV2 } from "../src/view-model/snapshot";
const v2 = fixture as unknown as SnapshotV2;
const review = v2.attention!.find(a => a.id === "review:t-0412")!;
const hello = (protocol: string, events: string[] = ["budget", "task", "mode", "alert", "config", "reset", "attention", "executor", "counts"]) => ({ pacer: "0.3.0", protocol, ops: ["repo.list"], events });
const v2State = () => reduceStore(reduceStore(initialState(), { type: "hello", hello: hello("2.1.0") }), { type: "snapshot", snapshot: v2 });
const ev = (seq: number, type: string, data: unknown) => ({ type: "event" as const, event: { seq, at: 1, type: type as "task", data } });

test("a 2.0 service keeps today's behaviour", () => {
  const state = reduceStore(initialState(), { type: "hello", hello: hello("2.0.0", ["budget", "task", "mode", "alert", "config", "reset"]) });
  expect(state.features.readModel).toBe(false);
  expect(state.version).toBe("0.3.0");
  const next = reduceStore(reduceStore(state, { type: "snapshot", snapshot }), ev(6, "task", { id: "t1", goal: "Work", state: "running", executor: null, backend: null, worktree: null, updatedAt: 1, repo: { key: "k", label: "l", path: "/p" } }));
  expect(next.snapshot?.tasks[0]?.id).toBe("t1");
  expect((next.snapshot?.tasks[0] as { repo?: unknown }).repo).toBeUndefined();
});

test("2.1 needs both the protocol and the attention event", () => {
  expect(reduceStore(initialState(), { type: "hello", hello: hello("2.1.0", ["task"]) }).features.readModel).toBe(false);
  expect(reduceStore(initialState(), { type: "hello", hello: hello("2.10.0") }).features.readModel).toBe(true);
  expect(reduceStore(initialState(), { type: "hello", hello: hello("3.0.0") }).features.readModel).toBe(true);
  expect([...reduceStore(initialState(), { type: "hello", hello: hello("2.1.0") }).features.ops]).toEqual(["repo.list"]);
});

test("2.1 task events keep the new fields and upsert by id", () => {
  const next = reduceStore(v2State(), ev(121, "task", { ...v2.tasks[0], state: "done", repo: { key: "github.com/acme/api", label: "acme/api", path: "/tmp/fixture/api" } }));
  expect(next.snapshot?.tasks[0]).toMatchObject({ id: "t-0420", state: "done", repo: { key: "github.com/acme/api" } });
  expect(next.snapshot?.tasks.length).toBe(v2.tasks.length);
  const added = reduceStore(next, ev(122, "task", { id: "t-0500", goal: "New", state: "queued", executor: null, backend: null, worktree: null, updatedAt: 2 }));
  expect(added.snapshot?.tasks[0]?.id).toBe("t-0500");
  const removed = reduceStore(added, ev(123, "task", { id: "t-0500", removed: true }));
  expect(removed.snapshot?.tasks.some(t => t.id === "t-0500")).toBe(false);
  expect(reduceStore(removed, ev(124, "task", { goal: "no id" }))).toBe(removed);
});

test("attention upsert inserts in order and replaces in place", () => {
  const start = v2State();
  const blocked = { ...review, id: "stuck:t-0420", kind: "stuck", severity: "blocked", raisedAt: 5 };
  const inserted = reduceStore(start, ev(121, "attention", blocked));
  expect(inserted.snapshot?.attention?.[0]?.id).toBe("stuck:t-0420");
  const changed = reduceStore(inserted, ev(122, "attention", { ...review, detail: "Changed" }));
  expect(changed.snapshot?.attention?.map(a => a.id)).toEqual(inserted.snapshot?.attention?.map(a => a.id));
  expect(changed.snapshot?.attention?.find(a => a.id === "review:t-0412")?.detail).toBe("Changed");
  expect(start.snapshot?.attention?.length).toBe(4);
});

test("removing an entity the snapshot never had is a no-op", () => {
  const start = v2State();
  const next = reduceStore(start, ev(121, "attention", { id: "nope", removed: true }));
  expect(next.snapshot?.attention).toBe(start.snapshot?.attention);
  const gone = reduceStore(start, ev(122, "attention", { id: "review:t-0412", removed: true }));
  expect(gone.snapshot?.attention?.some(a => a.id === "review:t-0412")).toBe(false);
});

test("events at or below the snapshot sequence are ignored", () => {
  const start = v2State();
  expect(reduceStore(start, ev(120, "counts", { ...v2.counts, attention: 99 }))).toBe(start);
});

test("executors, accounts, hosts and repos upsert by their keys; counts and pause replace", () => {
  let s = v2State();
  s = reduceStore(s, ev(121, "executor", { ...v2.executors![1]!, state: "busy" }));
  expect(s.snapshot?.executors?.[1]?.state).toBe("busy");
  s = reduceStore(s, ev(122, "executor", { ...v2.executors![1]!, id: "gemini" }));
  expect(s.snapshot?.executors?.at(-1)?.id).toBe("gemini");
  s = reduceStore(s, ev(123, "account", { ...v2.accounts![0]!, usedPct: 9 }));
  expect(s.snapshot?.accounts?.[0]?.usedPct).toBe(9);
  s = reduceStore(s, ev(124, "host", { alias: "buildbox", state: "ready" }));
  expect(s.snapshot?.hosts?.find(h => h.alias === "buildbox")?.state).toBe("ready");
  s = reduceStore(s, ev(125, "repo", { key: "github.com/acme/new", label: "acme/new", path: "/tmp/new" }));
  expect(s.snapshot?.repos?.[0]?.key).toBe("github.com/acme/new");
  s = reduceStore(s, ev(126, "counts", { ...v2.counts, attention: 9 }));
  expect(s.snapshot?.counts?.attention).toBe(9);
  s = reduceStore(s, ev(127, "pause", { until: 5, reason: null, by: "tray" }));
  expect(s.snapshot?.pause).toEqual({ until: 5, reason: null, by: "tray" });
  expect(s.snapshot?.seq).toBe(127);
});

test("jobs and activity accumulate outside the snapshot", () => {
  let s = v2State();
  s = reduceStore(s, ev(121, "job", { id: "j1", kind: "host.check", target: "devbox", state: "running", steps: [], startedAt: 1 }));
  s = reduceStore(s, ev(122, "job", { id: "j1", kind: "host.check", target: "devbox", state: "passed", steps: [], startedAt: 1, endedAt: 2 }));
  expect(s.jobs.j1?.state).toBe("passed");
  for (let i = 0; i < 205; i++) s = reduceStore(s, ev(123 + i, "activity", { id: `a${i}`, at: i, kind: "mode", level: "info", text: `entry ${i}` }));
  expect(s.activity.length).toBe(200);
  expect(s.activity[0]?.id).toBe("a204");
});

test("the live store listens to every event type the service announces", async () => {
  FakeEvents.instances = [];
  const api = { hello: async () => hello("2.1.0"), snapshot: async () => ({ protocol: "2.1.0", seq: 120, snapshot: v2 as never }), call: async <T>() => ({} as T) };
  const store = createStore(api, FakeEvents as any);
  const stop = store.start();
  await flush();
  expect(store.getState().features.readModel).toBe(true);
  FakeEvents.instances[0]!.emit("counts", { ...v2.counts, attention: 7 }, "121");
  expect(store.getState().snapshot?.counts?.attention).toBe(7);
  stop();
});

test("2.1 events move the snapshot time so snoozes end and 'updated' stays current", () => {
  const start = v2State();
  const next = reduceStore(start, { type: "event", event: { seq: 121, at: v2.at + 300, type: "counts", data: { ...v2.counts } } });
  expect(next.snapshot?.at).toBe(v2.at + 300);
  const job = reduceStore(start, { type: "event", event: { seq: 121, at: v2.at + 5, type: "job", data: { id: "j", kind: "host.check", target: "x", state: "running", steps: [], startedAt: 1 } } });
  expect(job.snapshot?.at).toBe(v2.at + 5);
});

test("an attention update that changes severity moves the item to its place", () => {
  const start = v2State();
  const moved = reduceStore(start, ev(121, "attention", { ...review, severity: "blocked" }));
  expect(moved.snapshot?.attention?.[0]?.id).toBe("review:t-0412");
});

test("a pause removal clears the pause", () => {
  const paused = reduceStore(v2State(), ev(121, "pause", { until: 5, by: "tray" }));
  expect(reduceStore(paused, ev(122, "pause", { id: "pause", removed: true })).snapshot?.pause).toBeNull();
});

test("attention and count events refresh the service-owned snapshot", () => {
  const start = reduceStore(initialState(), { type: "snapshot", snapshot });
  for (const type of ["attention", "counts"] as const) {
    expect(reduceStore(start, { type: "event", event: { seq: 6, at: 123, type, data: {} } }).needsSnapshot).toBe(true);
  }
});
test('desktop adoption events advance independently without regressing either revision',async()=>{
 const {desktopStatus,adoptionStatus}=await import('./fixtures/desktop-update/status');
 const old=desktopStatus({revision:7,adoption:adoptionStatus({phase:'waiting',revision:2})});
 let state: StoreState={...reduceStore(initialState(),{type:'snapshot',snapshot:{...snapshot,desktopUpdates:[old]}}),features:{readModel:true,ops:new Set<string>()}};
 const apply=(seq:number,data:typeof old)=>{state=reduceStore(state,{type:'event',event:{type:'desktop.update',seq,at:seq,data}});};
 apply(6,{...old,adoption:adoptionStatus({phase:'installing',revision:3})});
 expect(state.snapshot?.desktopUpdates?.[0]?.adoption?.phase).toBe('installing');
 apply(7,old);expect(state.snapshot?.desktopUpdates?.[0]?.adoption?.revision).toBe(3);
 apply(8,{...old,revision:8});expect(state.snapshot?.desktopUpdates?.[0]?.adoption?.revision).toBe(3);expect(state.needsSnapshot).toBe(true);
});

test("desktop connection recovery updates controls at the same durable revision", async () => {
  const { desktopStatus } = await import("./fixtures/desktop-update/status");
  const ready = desktopStatus({ revision: 7, phase: "ready", actions: ["restart", "check"] });
  let state: StoreState = { ...reduceStore(initialState(), { type: "snapshot", snapshot: { ...snapshot, desktopUpdates: [ready] } }),
    features: { readModel: true, ops: new Set<string>() } };
  const paused = { ...ready, actions: [], error: { code: "coordination_failed", message: "Rechecking update" } };
  state = reduceStore(state, { type: "event", event: { type: "desktop.update", seq: 6, at: 6, data: paused } });
  expect(state.snapshot?.desktopUpdates?.[0]?.actions).toEqual([]);
  expect(state.snapshot?.desktopUpdates?.[0]?.error?.code).toBe("coordination_failed");
  state = reduceStore(state, { type: "event", event: { type: "desktop.update", seq: 7, at: 7, data: ready } });
  expect(state.snapshot?.desktopUpdates?.[0]?.actions).toContain("restart");
  expect(state.snapshot?.desktopUpdates?.[0]?.error).toBeNull();
  const stale = reduceStore(state, { type: "event", event: { type: "desktop.update", seq: 6, at: 6, data: paused } });
  expect(stale).toBe(state);
});


test("closed streams and HTTP 502 refreshes keep retrying with bounded backoff until open", async () => {
  const { spyOn } = await import("bun:test");
  const pending: { callback: () => void; delay: number }[] = [];
  const original = globalThis.setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    if (delay >= 1000) { pending.push({ callback, delay }); return 123 as never; }
    return original(callback, delay);
  }) as typeof setTimeout);
  FakeEvents.instances = [];
  let unavailable = false;
  const api = { hello: async () => { if (unavailable) throw new ApiError("internal", "HTTP 502", undefined, 502); return hello("3.0.0"); }, snapshot: async () => ({ protocol: "3.0.0", seq: 120, snapshot: v2 as never }), call: async <T>() => ({} as T) };
  const store = createStore(api, FakeEvents as any), stop = store.start();
  try {
    await flush();
    FakeEvents.instances.at(-1)!.emit("open");
    expect(store.getState().connected).toBe(true);
    unavailable = true;
    FakeEvents.instances.at(-1)!.emit("error");
    await flush();
    expect(store.getState().connected).toBe(false);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const retry = pending.shift(); expect(retry?.delay).toBe(delay);
      retry?.callback(); await flush();
    }
    unavailable = false;
    pending.shift()!.callback(); await flush();
    // A new EventSource can itself receive an HTTP error even with hello/snapshot back.
    FakeEvents.instances.at(-1)!.emit("error"); await flush();
    expect(pending[0]?.delay).toBe(30000);
    pending.shift()!.callback(); await flush();
    FakeEvents.instances.at(-1)!.emit("open");
    expect(store.getState().connected).toBe(true);
    FakeEvents.instances.at(-1)!.emit("error"); await flush();
    expect(pending[0]?.delay).toBe(1000);
    stop();
    const count = FakeEvents.instances.length;
    pending.shift()!.callback(); await flush();
    expect(FakeEvents.instances.length).toBe(count);
  } finally { stop(); clock.mockRestore(); }
});

test("offline transport refuses direct operations without a request and resumes after reconnect", async () => {
  const { spyOn } = await import("bun:test");
  const request = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => Response.json(url.endsWith("hello") ? hello("3.0.0") : { result: { ok: true } })) as typeof fetch);
  try {
    const api = createApi();
    api.setConnected!(false);
    await expect(api.call("task.answer", {})).rejects.toMatchObject({ code: "offline", message: "pacer is offline" });
    expect(request).not.toHaveBeenCalled();
    api.setConnected!(true);
    await expect(api.call("task.answer", {})).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(2);
  } finally { request.mockRestore(); }
});

test('a stream error invalidates client query data even when its screen is unmounted',async()=>{
 const {queryCacheFor}=await import('../app/src/data/query');
 FakeEvents.instances=[];let reads=0;
 const api={hello:async()=>hello('3.0.0',[]),snapshot:async()=>({protocol:'3.0.0',seq:5,snapshot}),call:async<T>()=>{reads++;return ['repo'] as T;}};
 const cache=queryCacheFor(api,api.call),query=cache.createQuery(()=>{});
 query.update('repo.list','{}','online');await flush();query.dispose();expect(reads).toBe(1);
 const store=createStore(api,FakeEvents as any),stop=store.start();
 try {await flush();FakeEvents.instances[0]!.emit('open');FakeEvents.instances[0]!.emit('error');const remount=cache.createQuery(()=>{});remount.update('repo.list','{}','online');await flush();expect(reads).toBe(2);remount.dispose();}finally{stop();}
});

test('a separate screen API refreshes cached reads after a store reconnect while unmounted', async () => {
  const { queryCacheFor } = await import('../app/src/data/query');
  FakeEvents.instances = [];
  let reads = 0;
  const screenApi = { call: async <T>() => { reads++; return ['repo'] as T; } };
  const storeApi = { hello: async () => hello('3.0.0', []), snapshot: async () => ({ protocol: '3.0.0', seq: 5, snapshot }), call: async <T>() => ({} as T) };
  const store = createStore(storeApi, FakeEvents as any), stop = store.start();
  try {
    await flush();
    FakeEvents.instances[0]!.emit('open');
    const cache = queryCacheFor(screenApi, screenApi.call);
    const a = cache.createQuery(() => {});
    a.update('repo.list', '{}', JSON.stringify(store.getState().connectionRevision));
    await flush(); a.dispose();
    expect(reads).toBe(1);
    FakeEvents.instances[0]!.emit('error');
    const b = cache.createQuery(() => {});
    b.update('repo.list', '{}', JSON.stringify(store.getState().connectionRevision));
    await flush(); b.dispose();
    expect(reads).toBe(2);
  } finally { stop(); }
});
