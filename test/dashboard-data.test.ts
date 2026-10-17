import { expect, spyOn, test } from "bun:test";
import { ApiError, type ApiClient } from "../src/api/client";
import { emptySnapshot, type CmdData, type LinkSnapshot, type TaskData } from "../src/link/envelope";
import { cmdToOp, runCommand, delegateViaClient, refreshView, withFallback } from "../src/dashboard/data";

const task = (id: string, state = "running"): TaskData => ({ id, state, goal: id, executor: "codex", backend: "direct", worktree: null, updatedAt: 1 });
const snap = (tasks: TaskData[]): LinkSnapshot => ({ ...emptySnapshot(), seq: 1, tasks });
const fake = (s: LinkSnapshot): ApiClient => ({ kind: "inprocess", hello: async () => ({ protocol: "2.0.0", pacer: "0", ops: [], events: [] }), snapshot: async () => ({ protocol: "2.0.0", seq: s.seq, snapshot: s }), call: async () => { throw new Error("unused"); }, subscribe: () => () => {}, close: () => {} });

test("refresh keeps the selected card by id, else clamps", async () => {
  const before = snap([task("a"), task("b"), task("c")]);
  const reordered = snap([task("c"), task("b"), task("a")]);
  const r1 = await refreshView(fake(reordered), { snapshot: before, selected: 1, now: 10 });
  expect(r1.selected).toBe(1);
  expect(r1.snapshot).toBe(reordered);
  const r2 = await refreshView(fake(reordered), { snapshot: before, selected: 2, now: 10 });
  expect(r2.selected).toBe(0);
  const r3 = await refreshView(fake(snap([task("x")])), { snapshot: before, selected: 2, now: 10 });
  expect(r3.selected).toBe(0);
  const r4 = await refreshView(fake(snap([])), { snapshot: before, selected: 2, now: 10 });
  expect(r4.selected).toBe(0);
  const r5 = await refreshView(fake(reordered), { snapshot: before, selected: -1, now: 10 });
  expect(r5.selected).toBe(0);
});


test("cmdToOp maps exactly the op-backed commands", () => {
  expect(cmdToOp({ cmd: "stop", taskId: "t1" })).toEqual({ op: "task.stop", params: { id: "t1" } });
  expect(cmdToOp({ cmd: "retry", taskId: "t1", executor: "codex" })).toEqual({ op: "task.retry", params: { id: "t1", executor: "codex" } });
  expect(cmdToOp({ cmd: "retry", taskId: "t1" })).toEqual({ op: "task.retry", params: { id: "t1" } });
  expect(cmdToOp({ cmd: "dismiss", taskIds: ["a", "b"] })).toEqual({ op: "task.dismiss", params: { ids: ["a", "b"] } });
  expect(cmdToOp({ cmd: "dismiss", taskId: "a" })).toEqual({ op: "task.dismiss", params: { ids: ["a"] } });
  expect(cmdToOp({ cmd: "block", executor: "codex" })).toEqual({ op: "runner.block", params: { id: "codex" } });
  const block = { cmd: "block" as const, executor: "codex", for: "1h", reason: "reserved" };
  expect(cmdToOp(block)).toEqual({ op: "runner.block", params: { id: "codex", for: "1h", reason: "reserved" } });
  expect(cmdToOp({ cmd: "unblock", executor: "codex" })).toEqual({ op: "runner.unblock", params: { id: "codex" } });
  expect(cmdToOp({ cmd: "use", strategy: "night" })).toEqual({ op: "strategy.use", params: { name: "night" } });
  for (const cmd of ["focus", "refresh", "agent-done", "worktree-created"] as const) expect(cmdToOp({ cmd })).toBeNull();
});

test("op errors become pacer: messages; unmapped commands use the fallback", async () => {
  const reports: string[] = [], fell: string[] = [];
  const client = { ...fake(snap([])), call: async () => { throw new ApiError("conflict", "retry t-2 is already queued", "wait for it"); } };
  await runCommand(client, { cmd: "retry", taskId: "t1" }, async (d) => { fell.push(d.cmd); }, (s) => reports.push(s));
  expect(reports).toEqual(["pacer: retry t-2 is already queued (wait for it)"]);
  await runCommand(client, { cmd: "refresh" }, async (d) => { fell.push(d.cmd); }, (s) => reports.push(s));
  expect(fell).toEqual(["refresh"]);
});

test("op results produce dashboard success messages", async () => {
  const reports: string[] = [];
  const results: Record<string, unknown> = {
    "task.stop": { task_id: "t1", state: "stopped" },
    "task.retry": { retry: { task_id: "t2" }, of: { task_id: "t1" } },
    "task.dismiss": { dismissed: ["a", "b"], unknown: ["c"] },
    "runner.block": { ok: true }, "runner.unblock": { ok: true },
    "strategy.use": { name: "night", path: "strategy.yaml" },
  };
  const client: ApiClient = { ...fake(snap([])), call: async <T>(op: string) => results[op] as T };
  const fallback = async () => { throw new Error("unexpected fallback"); };
  const commands: CmdData[] = [{ cmd: "stop", taskId: "t1" }, { cmd: "retry", taskId: "t1" }, { cmd: "dismiss", taskIds: ["a", "b", "c"] }, { cmd: "block", executor: "codex" }, { cmd: "unblock", executor: "codex" }, { cmd: "use", strategy: "night" }];
  for (const data of commands) {
    await runCommand(client, data, fallback, s => reports.push(s));
  }
  expect(reports).toEqual(["t1 stopped", "t2 queued (retry of t1)", "dismissed 2; unknown: c", "blocked codex", "unblocked codex", "active strategy: night"]);
});

test("delegateViaClient sends prompt fields and reports queued tasks and errors", async () => {
  const reports: string[] = [], calls: unknown[] = [];
  const client: ApiClient = { ...fake(snap([])), call: async <T>(op: string, params?: unknown) => { calls.push({ op, params }); return { task_id: "t3" } as T; } };
  await delegateViaClient(client, { goal: "g", repo: "repo", kind: "test" }, s => reports.push(s));
  await delegateViaClient(client, { goal: "g", repo: "repo" }, s => reports.push(s));
  expect(calls).toEqual([{ op: "task.delegate", params: { goal: "g", repo: "repo", source: "ui", kind: "test" } }, { op: "task.delegate", params: { goal: "g", repo: "repo", source: "ui" } }]);
  expect(reports).toEqual(["t3 queued", "t3 queued"]);
  client.call = async () => { throw new ApiError("invalid_input", "bad kind"); };
  await delegateViaClient(client, { goal: "g", repo: "repo" }, s => reports.push(s));
  expect(reports.at(-1)).toBe("pacer: bad kind");
});


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
  const api = await import("../src/api/client");
  const setup = await import("../src/setup/check");
  const { runDashboard } = await import("../src/dashboard/cli");
  const { fakeCtx } = await import("./helpers");
  let resolveSnapshot!: (value: Awaited<ReturnType<ApiClient["snapshot"]>>) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let closes = 0, subscriptions = 0;
  const primary: ApiClient = { ...fake(snap([])), kind: "http",
    snapshot: () => { started(); return new Promise(resolve => { resolveSnapshot = resolve; }); },
    subscribe: () => { subscriptions++; return () => {}; }, close: () => { closes++; } };
  const connect = spyOn(api, "connectClient").mockResolvedValue(primary);
  const check = spyOn(setup, "checkSetup").mockImplementation(() => new Promise(() => {}));
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
    connect.mockRestore(); check.mockRestore(); write.mockRestore(); resume.mockRestore(); pause.mockRestore();
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

 test("dashboard hides commands whose ops were not advertised", async () => {
  const {commandAvailable}=await import("../src/dashboard/data");
  expect(commandAvailable({cmd:"retry-all",taskIds:["t1"]},["task.retry"])).toBe(false);
  expect(commandAvailable({cmd:"retry-all",taskIds:["t1"]},["task.retry_all"])).toBe(true);
  expect(commandAvailable({cmd:"focus",taskId:"t1"},[])).toBe(true);
 });

 test("TUI Retry all is only visible when advertised by hello",async()=>{
  const {cards}=await import("../src/dashboard/model");
  const snapshot=snap([]);snapshot.tasks=[{id:"t1",goal:"fix",state:"failed",updatedAt:1,executor:"codex",backend:null,worktree:null}];
  const actions=(ops:string[])=>cards(snapshot,10,ops).flatMap(g=>g.cards).filter(c=>c.text==="Retry all");
  expect(actions(["task.retry"])).toEqual([]);
  expect(actions(["task.retry_all"])[0]?.action).toEqual({cmd:"retry-all",taskIds:["t1"]});
 });

test("dashboard help hides unavailable operation shortcuts",async()=>{
 const {renderDashboard}=await import("../src/dashboard/render");
 const text=renderDashboard(snap([]),120,30,10,{selected:0,help:true,noColor:true,ops:[]});
 for(const label of ["d: delegate","x: dismiss","b: block","s: strategy","c: check updates","u: update"])expect(text).not.toContain(label);
});

test("Retry all excludes reviewed, resolved and superseded retry attempts",async()=>{
 const {cards}=await import("../src/dashboard/model");
 const snapshot=snap([]),base={goal:"fix",state:"failed",updatedAt:1,executor:"codex",backend:null,worktree:null};
 snapshot.tasks=[{...base,id:"old",retriedBy:"latest"},{...base,id:"latest",retryOf:"old"},{...base,id:"reviewed",review:{accepted:true,kind:null,note:null,at:2}},{...base,id:"resolved",resolved:"fixed"}];
 const action=()=>cards(snapshot,10,["task.retry_all"]).flatMap(g=>g.cards).find(c=>c.text==="Retry all")?.action;
 expect(action()).toEqual({cmd:"retry-all",taskIds:["latest"]});
 snapshot.tasks[1]={...snapshot.tasks[1],state:"done"};expect(action()).toBeUndefined();
});
