import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ApiError, HttpClient, connectClient } from "../src/api/client";
import { publish } from "../src/link/publish";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) stops.pop()!(); });

async function serve() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const s = startServer(() => ctx, { port: 0, tailMs: 20, pumpMs: 0, opDeps: { spawnRunner: () => 1 } });
  stops.push(s.stop);
  return { ctx, s, client: new HttpClient(`http://127.0.0.1:${s.port}`, s.token, { retryMs: 50 }) };
}

test("HttpClient calls ops and maps error bodies", async () => {
  const { client } = await serve();
  expect((await client.hello()).protocol).toBe("2.7.0");
  const r = await client.call<{ task_id: string }>("task.delegate", { goal: "g", repo: tmpDir() });
  expect(r.task_id).toMatch(/^t-/);
  const err = await client.call("task.get", { id: "missing" }).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("unknown_task");
});

test("subscribe reconnects after the stream ends", async () => {
  const { ctx, s, client } = await serve();
  const seen: number[] = [];
  const unsub = client.subscribe(0, (e) => seen.push(e.seq));
  const alert = (key: string) => ({ v: 1 as const, type: "alert" as const, data: { key, level: "info" as const, title: key, body: "", at: ctx.now } });
  await publish(ctx, [alert("a")], { bridge: false, channel: false });
  let end = Date.now() + 2000; while (seen.length < 1 && Date.now() < end) await Bun.sleep(10);
  s.stop();
  const again = startServer(() => ctx, { port: s.port, tailMs: 20, pumpMs: 0 });
  stops.push(again.stop);
  await publish(ctx, [alert("b")], { bridge: false, channel: false });
  end = Date.now() + 3000; while (seen.length < 2 && Date.now() < end) await Bun.sleep(10);
  unsub();
  expect(seen).toHaveLength(2);
  expect(seen[1]).toBeGreaterThan(seen[0]);
});

test("connectClient falls back when nothing or something else answers", async () => {
  const ctx = fakeCtx();
  expect((await connectClient({ ...ctx, env: { PACER_PORT: "1" } })).kind).toBe("inprocess");
  const other = Bun.serve({ port: 0, fetch: () => new Response("hi") });
  try {
    mkdirSync(ctx.pacerHome, { recursive: true }); await Bun.write(join(ctx.pacerHome, "token"), "x\n");
    expect((await connectClient({ ...ctx, env: { PACER_PORT: String(other.port) } })).kind).toBe("inprocess");
  } finally { other.stop(true); }
  const { ctx: c2, s } = await serve();
  expect((await connectClient({ ...c2, env: { PACER_PORT: String(s.port) } })).kind).toBe("http");
  expect((await connectClient({ ...c2, env: { PACER_PORT: String(s.port), PACER_API: "inprocess" } })).kind).toBe("inprocess");
});

test("HTTP snapshots report live task states and the server budget", async () => {
  const { ctx, client } = await serve();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = 2 ** 22 + 7; x.attemptStartedAt = ctx.now; });
  const result = await client.snapshot();
  expect(result.snapshot.tasks.find(x => x.id === t.id)?.state).toBe("failed");
  expect(result.snapshot.budget?.generatedAt).toBe(ctx.now);
});

test("SSE handles partial frames, comments and resume ids, and close stops reconnecting", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  const encoder = new TextEncoder();
  const server = Bun.serve({ port: 0, fetch(req) {
    requests.push({ url: req.url, headers: new Headers(req.headers) });
    const stream = new ReadableStream<Uint8Array>({ async start(controller) {
      if (requests.length === 1) {
        controller.enqueue(encoder.encode(': comment\r\nid: 7\r\nevent: alert\r\ndata: {"key":'));
        await Bun.sleep(10);
        controller.enqueue(encoder.encode('"a"}\r\n\r\n'));
      } else {
        controller.enqueue(encoder.encode('id: 99\nevent: reset\ndata: {"reason":"gap"}\n\n'));
      }
      controller.close();
    } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  stops.push(() => server.stop(true));
  const client = new HttpClient(`http://127.0.0.1:${server.port}`, "secret", { retryMs: 20 });
  stops.push(() => client.close());
  const seen: import("../src/api/protocol").ApiEvent[] = [];
  client.subscribe(3, e => { seen.push(e); if (seen.length === 2) client.close(); });
  const end = Date.now() + 2000;
  while (seen.length < 2 && Date.now() < end) await Bun.sleep(10);
  expect(seen.map(e => [e.seq, e.type, e.data])).toEqual([[7, "alert", { key: "a" }], [99, "reset", { reason: "gap" }]]);
  expect(requests[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(new URL(requests[0]!.url).searchParams.get("since")).toBe("3");
  expect(requests[1]!.headers.get("last-event-id")).toBe("7");
  await Bun.sleep(80);
  expect(requests).toHaveLength(2);
});

test("a wrong token surfaces as an ApiError, not a parse error", async () => {
  const { s } = await serve();
  const err = await new HttpClient(`http://127.0.0.1:${s.port}`, "wrong").hello().catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("not_allowed");
});


for (const method of ["snapshot", "call"] as const) {
  test(`HttpClient ${method} times out when the server never answers`, async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    stops.push(() => server.stop(true));
    const client = new HttpClient(`http://127.0.0.1:${server.port}`, "secret", { timeoutMs: 30 });
    stops.push(() => client.close());
    const result = await Promise.race([
      (method === "snapshot" ? client.snapshot() : client.call("task.list")).then(() => "resolved", () => "rejected"),
      Bun.sleep(300).then(() => "hung"),
    ]);
    expect(result).toBe("rejected");
  });
}

test("HttpClient close aborts in-flight requests, including response bodies", async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const server = Bun.serve({ port: 0, fetch() {
    started();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"protocol":')); } }));
  } });
  stops.push(() => server.stop(true));
  const client = new HttpClient(`http://127.0.0.1:${server.port}`, "secret");
  stops.push(() => client.close());
  const request = client.snapshot().then(() => "resolved", () => "rejected");
  await ready;
  await Bun.sleep(10);
  client.close();
  expect(await Promise.race([request, Bun.sleep(300).then(() => "hung")])).toBe("rejected");
});


for (const method of ["snapshot", "call"] as const) {
  test(`HttpClient ${method} aborts a stalled fetch on timeout or close`, async () => {
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch);
    try {
      for (const close of [false, true]) {
        const client = new HttpClient("http://127.0.0.1:12345", "secret", { timeoutMs: close ? 15000 : 30 });
        const pending = (method === "snapshot" ? client.snapshot() : client.call("task.list"))
          .then(() => "resolved", () => "rejected");
        if (close) client.close();
        const result = await Promise.race([pending, Bun.sleep(300).then(() => "hung")]);
        client.close();
        expect(result).toBe("rejected");
      }
    } finally { fetcher.mockRestore(); }
  });
}
