import { expect, spyOn, test } from "bun:test";
import { ApiError, type ApiClient } from "../src/api/client";
import { emptySnapshot, type LinkSnapshot, type TaskData } from "../src/link/envelope";
import { withFallback } from "../src/dashboard/data";

const task = (id: string, state = "running"): TaskData => ({ id, state, goal: id, executor: "codex", backend: "direct", worktree: null, updatedAt: 1 });
const snap = (tasks: TaskData[]): LinkSnapshot => ({ ...emptySnapshot(), seq: 1, tasks });
const fake = (s: LinkSnapshot): ApiClient => ({ kind: "inprocess", hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: s.seq, snapshot: s }), call: async () => { throw new Error("unused"); }, subscribe: () => () => {}, close: () => {} });

test("daemon transport failures switch once and resume subscriptions from the last snapshot", async () => {
  const resumed: number[] = [], delivered: number[] = [];
  let closed = 0, stopped = 0, switches = 0, made = 0;
  const primary: ApiClient = { ...fake(snap([])), kind: "http", close: () => { closed++; },
    subscribe: () => () => { stopped++; } };
  const local: ApiClient = { ...fake(snap([])), call: async <T>() => "local" as T,
    subscribe: (since, onEvent) => { resumed.push(since); onEvent({ seq: 8, at: 0, type: "alert", data: {} }); return () => {}; } };
  const client = withFallback(primary, () => { made++; return local; }, () => { switches++; });
  primary.snapshot = async () => ({ protocol: "2.0.0", seq: 7, snapshot: { ...snap([]), seq: 7 } });
  await client.snapshot();
  const unsubscribe = client.subscribe(7, event => delivered.push(event.seq));
  primary.snapshot = async () => { throw new TypeError("fetch failed"); };
  await client.snapshot();
  expect(client.kind).toBe("inprocess");
  expect(await client.call<string>("task.list")).toBe("local");
  expect(resumed).toEqual([7]);
  expect(delivered).toEqual([8]);
  expect([closed, stopped, switches, made]).toEqual([1, 1, 1, 1]);
  unsubscribe(); client.close();
});

test("fallback applies to ops and hello, but preserves API errors", async () => {
  for (const method of ["hello", "call"] as const) {
    let switched = 0;
    const primary: ApiClient = { ...fake(snap([])), kind: "http" };
    const error = new ApiError("conflict", "busy");
    primary[method] = async () => { throw error; };
    const client = withFallback(primary, () => fake(snap([])), () => { switched++; });
    await expect(client[method]("task.list")).rejects.toBe(error);
    expect(switched).toBe(0);
    primary[method] = async () => { throw new TypeError("fetch failed"); };
    const local = fake(snap([]));
    local.call = async <T>() => "local" as T;
    const retrying = withFallback(primary, () => local, () => { switched++; });
    // Reads retry locally; operations switch without repeating, since the daemon may have applied them.
    if (method === "hello") await retrying.hello();
    else await expect(retrying.call("task.list")).rejects.toBeInstanceOf(TypeError);
    expect(switched).toBe(1);
    client.close(); retrying.close();
  }
});

test("dashboard can quit while its first snapshot is pending", async () => {
  const api = await import("../src/dashboard/client");
  const { runDashboard } = await import("../src/dashboard/cli");
  const { fakeCtx } = await import("./helpers");
  let resolveSnapshot!: (value: Awaited<ReturnType<ApiClient["snapshot"]>>) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let closes = 0, subscriptions = 0;
  const primary: ApiClient = { ...fake(snap([])), kind: "http",
    snapshot: () => { started(); return new Promise(resolve => { resolveSnapshot = resolve; }); },
    subscribe: () => { subscriptions++; return () => {}; }, close: () => { closes++; } };
  const connect = spyOn(api, "dashboardClient").mockImplementation(async (_ctx,local)=>local?fake(snap([])):primary);
  const write = spyOn(process.stdout, "write").mockReturnValue(true);
  const resume = spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  const pause = spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
  const properties = [
    [process.stdin, "isTTY", true], [process.stdout, "isTTY", true],
    [process.stdin, "setRawMode", () => process.stdin],
  ] as const;
  const descriptors = properties.map(([object, key]) => Object.getOwnPropertyDescriptor(object, key));
  properties.forEach(([object, key, value]) => Object.defineProperty(object, key, { configurable: true, value }));
  try {
    const running = runDashboard([], fakeCtx());
    await ready;
    process.stdin.emit("data", Buffer.from("q"));
    const result = await Promise.race([running, Bun.sleep(100).then(() => "hung")]);
    resolveSnapshot({ protocol: "2.0.0", seq: 1, snapshot: snap([]) });
    await running;
    await Bun.sleep(0);
    expect(result).toEqual({ code: 0, out: "", err: "" });
    expect(closes).toBe(1);
    expect(subscriptions).toBe(0);
  } finally {
    properties.forEach(([object, key], i) => {
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else Reflect.deleteProperty(object, key);
    });
    connect.mockRestore(); write.mockRestore(); resume.mockRestore(); pause.mockRestore();
  }
});

test("withFallback switches to local but does not repeat an operation after a transport error", async () => {
  const { withFallback } = await import("../src/dashboard/data");
  let localCalls = 0, switched = 0;
  const http = { kind: "http" as const, hello: async () => { throw new TypeError("fetch failed"); }, snapshot: async () => { throw new TypeError("fetch failed"); }, call: async () => { throw new TypeError("fetch failed"); }, subscribe: () => () => {}, close: () => {} };
  const local = { kind: "inprocess" as const, hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }), snapshot: async () => { throw new Error("unused"); }, call: async () => { localCalls++; return { task_id: "t" }; }, subscribe: () => () => {}, close: () => {} };
  const client = withFallback(http as never, () => local as never, () => { switched++; });
  expect(await client.call("task.delegate", { goal: "g" }).catch((e) => e)).toBeInstanceOf(TypeError);
  expect(switched).toBe(1);
  expect(localCalls).toBe(0);
  expect(client.kind).toBe("inprocess");
  expect(await client.call<{ task_id: string }>("task.list", {})).toEqual({ task_id: "t" });
  expect(localCalls).toBe(1);
});


