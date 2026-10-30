import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { handleV2 } from "../src/api/http";
import { publish } from "../src/link/publish";
import { appendOutbox } from "../src/link/store";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

let stop: (() => void | Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

async function serve(reactive = false) {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\nproviders:\n  claude-code: {${reactive ? "usage: reactive" : ""}}\n  codex: {${reactive ? "usage: reactive" : ""}}\n`);
  const spawned: string[] = [];
  const s = startServer(() => ctx, { port: 0, sseIntervalMs: 50, tailMs: 50, pumpMs: 0, opDeps: { spawnRunner: (_c, id) => { spawned.push(id); return 1; } } });
  stop = s.stop;
  return { ctx, spawned, url: `http://127.0.0.1:${s.port}`, h: { authorization: `Bearer ${s.token}` } };
}
const post = (url: string, h: Record<string, string>, body: string) => fetch(url, { method: "POST", headers: { ...h, "content-type": "application/json" }, body });

async function readSse(res: Response, n: number): Promise<string> {
  const reader = res.body!.getReader(), dec = new TextDecoder(); let text = "";
  while ((text.match(/(?:^|\n)event:/g) ?? []).length < n) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value); }
  await reader.cancel(); return text;
}

test("hello and snapshot need the token and describe the protocol", async () => {
  const { url, h } = await serve();
  expect((await fetch(`${url}/v2/hello`)).status).toBe(401);
  const hello = await (await fetch(`${url}/v2/hello`, { headers: h })).json();
  expect(hello).toMatchObject({ protocol: "2.8.0", ops: expect.arrayContaining(["task.list", "limits.check"]) });
  expect(await (await fetch(`${url}/v2/snapshot`, { headers: h })).json()).toMatchObject({ protocol: "2.8.0", seq: expect.any(Number) });
});

test("ops run through the registry and return results", async () => {
  const { url, h, spawned } = await serve();
  const r = await post(`${url}/v2/ops/task.delegate`, h, JSON.stringify({ goal: "g", repo: tmpDir() }));
  expect(r.status).toBe(200);
  const { result } = await r.json();
  expect(spawned).toEqual([result.task_id]);
});

test("ops reject bad JSON, wrong params and oversized bodies", async () => {
  const { url, h } = await serve();
  expect((await post(`${url}/v2/ops/task.get`, h, "{")).status).toBe(400);
  const bad = await post(`${url}/v2/ops/task.get`, h, JSON.stringify({ id: 1 }));
  expect(bad.status).toBe(400);
  expect((await bad.json()).error.code).toBe("invalid_input");
  expect((await post(`${url}/v2/ops/task.get`, h, JSON.stringify({ id: "x".repeat(300_000) }))).status).toBe(413);
});

test("unknown op and unknown task map to 404 with codes", async () => {
  const { url, h } = await serve();
  const a = await post(`${url}/v2/ops/task.nope`, h, "{}");
  expect([a.status, (await a.json()).error.code]).toEqual([404, "unknown_op"]);
  const b = await post(`${url}/v2/ops/task.get`, h, JSON.stringify({ id: "missing" }));
  expect([b.status, (await b.json()).error.code]).toEqual([404, "unknown_task"]);
});

test("SSE resumes from Last-Event-ID", async () => {
  const { ctx, url, h } = await serve(true);
  await publish(ctx, [{ type: "alert", data: { key: "a", level: "info", title: "a", body: "", at: ctx.now } }, { type: "alert", data: { key: "b", level: "info", title: "b", body: "", at: ctx.now } }]);
  const first = await fetch(`${url}/v2/events?since=0`, { headers: h });
  const text = await readSse(first, 2);
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  expect(ids).toHaveLength(2);
  const resumed = await readSse(await fetch(`${url}/v2/events`, { headers: { ...h, "last-event-id": String(ids[0]) } }), 1);
  expect(resumed).toContain(`id: ${ids[1]}`);
});

test("SSE on a fresh outbox whose oldest entry is newer than since sends reset first", async () => {
  const { ctx, url, h } = await serve(true);
  appendOutbox(ctx, [{ seq: 1000, envelope: { type: "alert", data: { key: "z", level: "info", title: "z", body: "", at: ctx.now } } }]);
  const gap = await readSse(await fetch(`${url}/v2/events?since=500`, { headers: h }), 2);
  expect(gap.indexOf("event: reset")).toBeGreaterThanOrEqual(0);
  expect(gap.indexOf("event: reset")).toBeLessThan(gap.indexOf("id: 1000"));
});

test("ops cap UTF-8 bodies by bytes", async () => {
  const { url, h } = await serve();
  const r = await post(`${url}/v2/ops/task.get`, h, JSON.stringify({ id: "é".repeat(140_000) }));
  expect([r.status, (await r.json()).error.code]).toEqual([413, "too_large"]);
});

test("ops reject oversized content-length before reading the body", async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.close(); } }, { highWaterMark: 0 });
  const req = new Request("http://localhost/v2/ops/task.get", {
    method: "POST", headers: { "content-length": String(256 * 1024 + 1) }, body,
  });
  const res = await handleV2(req, { getCtx: () => fakeCtx() });
  expect(res.status).toBe(413);
  expect(reads).toBe(0);
});

test("ops cancel an oversized streamed body without content-length", async () => {
  let reads = 0, cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ < 8) controller.enqueue(new Uint8Array(64 * 1024));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const req = new Request("http://localhost/v2/ops/task.get", { method: "POST", body });
  expect(req.headers.has("content-length")).toBe(false);
  const res = await handleV2(req, { getCtx: () => fakeCtx() });
  expect([res.status, (await res.json()).error.code]).toEqual([413, "too_large"]);
  expect(cancelled).toBe(true);
  expect(reads).toBe(5);
});

test("log follow streams new output and ends when the task is done", async () => {
  const { ctx, url, h } = await serve();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const dir = tmpDir();
  await Bun.write(join(dir, "stdout"), "first\n");
  await Bun.write(join(dir, "stderr"), "warning\n");
  updateTask(ctx, t.id, x => {
    x.state = "running";
    x.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: ctx.home, logFile: "" };
  });
  const res = await fetch(`${url}/v2/tasks/${t.id}/log?follow=1`, { headers: h });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let first = "";
  while (!first.includes("event: log\n")) { const chunk = await reader.read(); if (chunk.done) break; first += dec.decode(chunk.value); }
  expect(first).toContain('event: log\ndata: {"stdout":"first\\n","stderr":"warning\\n"}');
  await Bun.write(join(dir, "stdout"), "first\nsecond\n");
  updateTask(ctx, t.id, x => { x.state = "done"; });
  let rest = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += dec.decode(value);
  }
  expect(rest).toContain('data: {"stdout":"second\\n","stderr":""}');
  expect(rest).toContain("event: done\n");
  expect(rest).not.toContain("first");
  const missing = await fetch(`${url}/v2/tasks/missing/log?follow=1`, { headers: h });
  expect([missing.status, (await missing.json()).error.code]).toEqual([404, "unknown_task"]);
});

test("log follow paces completed logs at four chunks per tick before done", async () => {
  const ctx = fakeCtx(), dir = tmpDir(), chunkBytes = 256 * 1024;
  const output = Array.from({ length: 12 }, (_, i) => String.fromCharCode(65 + i).repeat(chunkBytes));
  await Bun.write(join(dir, "stdout"), output.join(""));
  const t = createTask(ctx, { brief: { goal: "g", repo: dir }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => {
    x.state = "done";
    x.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: dir, logFile: "" };
  });
  // Read directly so network buffering cannot merge frames from different ticks.
  const res = await handleV2(new Request(`http://localhost/v2/tasks/${t.id}/log?follow=1`), { getCtx: () => ctx, tailMs: 10 });
  const reader = res.body!.getReader(), decoder = new TextDecoder();
  const batches: string[][] = [];
  let batch: string[] = [], doneFrame = false;
  // Each check-phase callback runs after the current timer tick's queued frames drain.
  const flush = () => { if (batch.length) { batches.push(batch); batch = []; } };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const frame = decoder.decode(value);
      if (frame.startsWith("event: log\n")) {
        const data = JSON.parse(frame.split("\ndata: ")[1]!.trim());
        expect(doneFrame).toBe(false);
        expect(data.stderr).toBe("");
        batch.push(data.stdout);
        if (batch.length === 1) setImmediate(flush);
      } else if (!frame.startsWith(":")) {
        expect(frame).toBe("event: done\ndata: {}\n\n");
        doneFrame = true;
      }
    }
    flush();
    expect(doneFrame).toBe(true);
    expect(batches.every(b => b.length <= 4)).toBe(true);
    expect(batches.flat()).toEqual(output);
  } finally { await reader.cancel(); }
});

test("idle SSE events and log follow deliver the first chunk within one second", async () => {
  const ctx = fakeCtx(), dir = tmpDir();
  const task = createTask(ctx, { brief: { goal: "g", repo: dir }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: dir, logFile: "" }; });
  for (const path of ["/v2/events", `/v2/tasks/${task.id}/log?follow=1`]) {
    const response = await handleV2(new Request(`http://localhost${path}`), { getCtx: () => ctx });
    const reader = response.body!.getReader();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("first SSE chunk exceeded 1 s")), 1000); })]);
      expect(new TextDecoder().decode(chunk.value)).toBe(": connected\n\n");
    } finally { clearTimeout(timeout); await reader.cancel(); }
  }
});

test("client version header labels delegated tasks and ignores invalid labels",async()=>{
 const {handleV2}=await import("../src/api/http");
 const {fakeCtx}=await import("./helpers");
 const {mkdirSync}=await import("node:fs");const {join}=await import("node:path");
 const {readTask}=await import("../src/tasks/store");
 const ctx=fakeCtx();mkdirSync(ctx.pacerHome,{recursive:true});
 await Bun.write(join(ctx.pacerHome,"strategy.yaml"),"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 for(const client of ["tui/0.3.0","<script>"]){
 const response=await handleV2(new Request("http://localhost/v2/ops/task.delegate",{method:"POST",headers:{"X-Pacer-Client":client},body:JSON.stringify({goal:"test",repo:ctx.home})}),{getCtx:()=>ctx,opDeps:{spawnRunner:()=>1}});
 expect(response.status).toBe(200);const body=await response.json() as any;
 expect(readTask(ctx,body.result.task_id)?.client).toBe(client==="tui/0.3.0"?client:undefined);
 }
});

for (const major of [2, 3]) test(`v${major} clients receive pause, resume and expiry events`, async () => {
  const ctx = fakeCtx(), url = "http://localhost";
  const request = async (input: string, init?: RequestInit) => handleV2(new Request(input, init), {getCtx:() => ctx});
  const op = (name: string, body: string) => request(`${url}/v${major}/ops/${name}`, {method:"POST", body});
  const { pumpOnce } = await import("../src/link/pump");
  const hello = await (await request(`${url}/v${major}/hello`)).json();
  expect(hello.events).toContain("pause");
  const pause = async () => {
    const response = await op("delegation.pause", JSON.stringify({for:"1m", reason:"Review work"}));
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
  const state = await pause();
  expect((await op("delegation.resume", "{}")).status).toBe(200);
  await pause();
  await pumpOnce({...ctx, now:ctx.now+60}, {
    status:async () => {throw new Error("provider unavailable");}, tasks:() => [], publish,
  });
  const { eventsSince } = await import("../src/api/events");
  const count = eventsSince(ctx, 0, major as 2 | 3).events.length;
  const text = await readSse(await request(`${url}/v${major}/events?since=0`), count);
  const data = text.split("\n\n").filter(frame => frame.includes("event: pause\n"))
    .map(frame => JSON.parse(frame.match(/^data: (.+)$/m)![1]!));
  expect(data).toEqual([state, {removed:true}, state, {removed:true}]);
});
