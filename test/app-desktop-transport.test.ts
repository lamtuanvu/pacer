import { expect, spyOn, test } from "bun:test";
import { createApi } from "../app/src/data/api";
import { createStore, initialState, reduceStore } from "../app/src/data/store";
import { emptySnapshot } from "../src/link/envelope";
import { desktopStatus } from "./fixtures/desktop-update/status";
const hello = (protocol = "3.0.0") => ({ protocol, pacer: "0.2.3", ops: ["desktop.update.check"], events: ["attention", "desktop.update"] });

test("browser negotiates v3 once for concurrent reads then routes desktop operations to v3", async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    paths.push(url); return Response.json(url.endsWith("hello") ? hello() : url.includes("snapshot") ? { protocol: "3.0.0", seq: 1, snapshot: emptySnapshot() } : { result: "checked" });
  }) as typeof fetch);
  try {
    const api = createApi();
    await Promise.all([api.hello(), api.snapshot()]);
    // Concurrent reads share one v3 negotiation; none of that traffic may be /v2.
    expect(paths.filter(p => p === "/v3/hello")).toHaveLength(1);
    expect(paths.filter(p => p === "/v3/snapshot")).toHaveLength(1);
    const reads = paths.length;
    expect(await api.call<string>("desktop.update.check", {})).toBe("checked");
    // Ops re-probe the expired negotiation, then route to the v3 console.
    expect(paths.slice(reads)).toEqual(["/v3/hello", "/v3/ops/desktop.update.check"]);
    await api.hello(); expect(paths.at(-1)).toBe("/v3/hello"); // probes must recheck expired sessions
    expect(paths.every(p => p.startsWith("/v3"))).toBe(true);
  } finally { fetchSpy.mockRestore(); }
});
for (const response of [404, 426, "4.0.0"] as const) test(`browser rejects a service that is not protocol 3 (${response})`, async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    paths.push(url);
    if (url === "/v3/hello") return typeof response === "number" ? new Response(null, { status: response }) : Response.json(hello(response));
    return Response.json({ result: "legacy" });
  }) as typeof fetch);
  try {
    const api = createApi();
    await expect(api.hello()).rejects.toThrow("This service protocol is not supported.");
    expect(paths).toEqual(["/v3/hello"]);
  } finally { fetchSpy.mockRestore(); }
});
for (const failure of [401, 403, 500, "network", "malformed"] as const) test(`browser does not downgrade ${failure} failures`, async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    paths.push(url);
    if (failure === "network") throw new Error("Disconnected");
    return failure === "malformed" ? Response.json({ protocol: "banana" }) : new Response(null, { status: failure });
  }) as typeof fetch);
  try { await expect(createApi().hello()).rejects.toThrow(); expect(paths).toEqual(["/v3/hello"]); }
  finally { fetchSpy.mockRestore(); }
});
test("desktop events preserve installations and advance transport sequence without regressing their revisions", () => {
  const a = desktopStatus({ installationId: "a", revision: 4 }), b = desktopStatus({ installationId: "b", revision: 2 });
  let state = reduceStore(reduceStore(initialState(), { type: "hello", hello: hello() }), { type: "snapshot", snapshot: { ...emptySnapshot(), seq: 10, desktopUpdates: [a, b] } });
  const event = (seq: number, update: ReturnType<typeof desktopStatus>) => ({ type: "event" as const, event: { seq, at: 1, type: "desktop.update" as const, data: update } });
  state = reduceStore(state, event(11, { ...a, revision: 5, phase: "ready" }));
  state = reduceStore(state, event(12, { ...a, revision: 4, phase: "idle" }));
  state = reduceStore(state, event(13, { ...a, revision: 5, phase: "idle" }));
  expect(state.snapshot?.desktopUpdates).toEqual([{ ...a, revision: 5, phase: "ready" }, b]);
  expect(state.snapshot?.seq).toBe(13);
  state = reduceStore(state, { type: "snapshot", snapshot: { ...emptySnapshot(), seq: 14, desktopUpdates: [{ ...a, revision: 6, phase: "complete" }, b] } });
  expect(state.snapshot?.desktopUpdates?.[0]?.phase).toBe("complete");
});
test("v3 store subscribes to matching event endpoint", async () => {
  const urls: string[] = [];
  class Events { constructor(url: string) { urls.push(url); } close() {} addEventListener() {} }
  const store = createStore({ hello: async () => hello(), snapshot: async () => ({ protocol: "3.0.0", seq: 6, snapshot: emptySnapshot() }), call: async <T>() => ({} as T) }, Events as unknown as typeof EventSource);
  const stop = store.start(); await new Promise(resolve => setTimeout(resolve, 0)); stop(); expect(urls).toEqual(["/v3/events?since=6"]);
});
test("the app only ever speaks protocol 3, never falling back to /v2", async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    paths.push(url);
    return url.includes("snapshot") ? Response.json({ protocol: "3.0.0", seq: 1, snapshot: emptySnapshot() }) : url.endsWith("hello") ? Response.json(hello()) : Response.json({ result: "ok" });
  }) as typeof fetch);
  try {
    const api = createApi();
    await api.hello();
    await api.call("task.list", { states: ["running"] });
    expect(paths.every(p => p.startsWith("/v3"))).toBe(true);
    expect(paths.some(p => p.startsWith("/v2"))).toBe(false);
  } finally { fetchSpy.mockRestore(); }
});
test("v3 planner events refresh the same planner read model", () => {
  const state = reduceStore(reduceStore(initialState(), { type: "hello", hello: hello() }), { type: "snapshot", snapshot: { ...emptySnapshot(), seq: 1 } });
  const planner = { agent: "codex", runner: "codex", usedPct: 42, pacePct: 45, verdict: "on_pace" as const, resetsAt: null, window: "week", stale: false, mode: "normal", advice: "Available", deltaPts: -3, activeHoursLeft: 1 };
  const next = reduceStore(state, { type: "event", event: { seq: 2, at: 3, type: "planner", data: planner } });
  expect(next.snapshot?.planner).toEqual(planner); expect(next.snapshot?.seq).toBe(2);
});
