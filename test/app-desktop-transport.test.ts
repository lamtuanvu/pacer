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
    const api = createApi(); await Promise.all([api.hello(), api.snapshot()]);
    expect(await api.call<string>("desktop.update.check", {})).toBe("checked");
    expect(paths).toEqual(["/v3/hello", "/v3/snapshot", "/v3/ops/desktop.update.check"]);
    await api.hello(); expect(paths.at(-1)).toBe("/v3/hello"); // probes must recheck expired sessions
  } finally { fetchSpy.mockRestore(); }
});
for (const response of [404, 426, "4.0.0"] as const) test(`browser falls back only after explicit unsupported protocol (${response})`, async () => {
  const paths: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
    paths.push(url);
    if (url === "/v3/hello") return typeof response === "number" ? new Response(null, { status: response }) : Response.json(hello(response));
    return Response.json(url.endsWith("hello") ? hello("2.1.0") : { result: "legacy" });
  }) as typeof fetch);
  try {
    const api = createApi(); expect((await api.hello()).protocol).toBe("2.1.0");
    await api.call("update.check"); expect(paths.at(-1)).toBe("/v2/ops/update.check");
    await expect(api.call("desktop.update.check")).rejects.toThrow();
    expect(paths.some(path => path.includes("ops/desktop.update"))).toBe(false);
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
test("fallback capability filtering persists across session probes", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string) => url === "/v3/hello" ? new Response(null, { status: 404 }) : Response.json(hello("2.1.0"))) as typeof fetch);
  try { const api = createApi(); await api.hello(); expect((await api.hello()).ops).toEqual([]); expect((await api.hello()).events).not.toContain("desktop.update"); }
  finally { fetchSpy.mockRestore(); }
});
test("v3 planner events refresh the same planner read model", () => {
  const state = reduceStore(reduceStore(initialState(), { type: "hello", hello: hello() }), { type: "snapshot", snapshot: { ...emptySnapshot(), seq: 1 } });
  const planner = { agent: "codex", runner: "codex", usedPct: 42, pacePct: 45, verdict: "on_pace" as const, resetsAt: null, window: "week", stale: false, mode: "normal", advice: "Available", deltaPts: -3, activeHoursLeft: 1 };
  const next = reduceStore(state, { type: "event", event: { seq: 2, at: 3, type: "planner", data: planner } });
  expect(next.snapshot?.planner).toEqual(planner); expect(next.snapshot?.seq).toBe(2);
});
