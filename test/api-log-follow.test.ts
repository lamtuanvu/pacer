import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { fakeCtx, tmpDir } from "./helpers";

let stop: (() => void | Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });
async function fixture() {
  const ctx = fakeCtx(), dir = tmpDir();
  const task = createTask(ctx, { brief: { goal: "follow output", repo: dir }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.run = { dir, attempt: 1, executor: "codex", startedAt: ctx.now, mode: "current", workdir: dir, logFile: "" }; });
  const server = startServer(() => ctx, { port: 0, tailMs: 10, pumpMs: 0 });
  stop = server.stop;
  return { ctx, dir, task, url: `http://127.0.0.1:${server.port}`, headers: { authorization: `Bearer ${server.token}` } };
}
for (const major of [2, 3]) test(`v${major} log follow sends initial and appended output, then done`, async () => {
  const { ctx, dir, task, url, headers } = await fixture();
  await Bun.write(join(dir, "stdout"), "first\n");
  await Bun.write(join(dir, "stderr"), "warning\n");
  const response = await fetch(`${url}/v${major}/tasks/${task.id}/log?follow=1`, { headers, signal: AbortSignal.timeout(3000) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  try {
    let initial = "";
    while (!initial.includes("event: log\n")) { const chunk = await reader.read(); if (chunk.done) break; initial += decoder.decode(chunk.value); }
    expect(initial).toContain('event: log\ndata: {"stdout":"first\\n","stderr":"warning\\n"}\n\n');
    await Bun.write(join(dir, "stdout"), "first\nsecond\n");
    updateTask(ctx, task.id, t => { t.state = "done"; });
    let rest = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += decoder.decode(chunk.value); }
    expect(rest).toBe('event: log\ndata: {"stdout":"second\\n","stderr":""}\n\nevent: done\ndata: {}\n\n');
  } finally { await reader.cancel(); }
});
for (const major of [2, 3]) test(`v${major} log follow keeps HTTP errors before SSE headers`, async () => {
  const { url, headers } = await fixture();
  for (const [suffix, method, status, code] of [["?follow=1", "GET", 404, "unknown_task"], ["", "GET", 404, "unknown_op"], ["?follow=1", "POST", 405, "invalid_input"]] as const) {
    const response = await fetch(`${url}/v${major}/tasks/missing/log${suffix}`, { method, headers });
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await response.json()).error.code).toBe(code);
  }
});
for (const major of [2, 3]) test(`v${major} log follow uses public bearer/cookie and Host/Origin protections`, async () => {
  const { url, headers } = await fixture(), path = `${url}/v${major}/tasks/missing/log?follow=1`;
  expect((await fetch(path)).status).toBe(401);
  expect((await fetch(path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await fetch(path, { headers: { ...headers, host: "foreign.invalid" } })).status).toBe(421);
  const exchange = await fetch(`${url}/v${major}/session/exchange`, { method: "POST", headers });
  const cookie = exchange.headers.get("set-cookie")!.split(";")[0]!;
  for (const site of ["cross-site", "same-site"]) expect((await fetch(path, { headers: { cookie, origin: "https://foreign.invalid", "sec-fetch-site": site } })).status).toBe(403);
  // GET follows the same cookie policy as v2: no write-only Origin/client-header requirement.
  const allowed = await fetch(path, { headers: { cookie, origin: url, "sec-fetch-site": "same-origin" } });
  expect(allowed.status).toBe(404);
  expect((await allowed.json()).error.code).toBe("unknown_task");
  expect((await fetch(path, { method: "OPTIONS", headers })).status).toBe(405);
});
test("public v3 docs list log follow without changing the protocol major", () => {
  expect(renderProtocolDoc()).toContain("GET /v3/tasks/<id>/log?follow=1");
});
