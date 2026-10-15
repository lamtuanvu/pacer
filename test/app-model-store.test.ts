import { expect, test, spyOn } from "bun:test";
import { emptySnapshot } from "../src/link/envelope";
import { initialState, reduceStore, createStore } from "../app/src/store";
import { ApiError, createApi } from "../app/src/api";

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

test("reset and reconnect require a snapshot; errors retain content; config invalidates only its area", () => {
  const start = reduceStore(initialState(), { type: "snapshot", snapshot });
  const config = reduceStore(start, { type: "event", event: { seq: 6, at: 1, type: "config", data: { area: "accounts", at: 1 } } });
  expect(config.invalidations).toEqual({ accounts: 1 });
  expect(config.snapshot?.seq).toBe(6);
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
    calls.push(init!);
    return Response.json({ error: { code: "invalid_input", message: "Bad name", hint: "Choose a name" } }, { status: 400 });
  }) as unknown as typeof fetch);
  try {
    await expect(createApi().call("config.set", { key: "planner" })).rejects.toMatchObject({ code: "invalid_input", message: "Bad name", hint: "Choose a name" });
    expect(calls[0]?.credentials).toBe("same-origin");
    expect(new Headers(calls[0]?.headers).get("X-Pacer-Client")).toBe("app");
    expect(new Headers(calls[0]?.headers).get("content-type")).toBe("application/json");
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
test("live store snapshots before streaming and refetches on reset and reconnect", async () => {
  FakeEvents.instances = [];
  let reads = 0;
  const api = { hello: async () => ({ pacer: "1.0.0", protocol: "2.0.0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: 5 + reads, snapshot: { ...snapshot, seq: 5 + reads++ } }), call: async <T>() => ({} as T) };
  const store = createStore(api, FakeEvents as any);
  const stop = store.start();
  await flush();
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
