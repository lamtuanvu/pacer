import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { createTask, listTasks } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

/** The background worker mirrors its health here so diagnostics and tests can read it. */
function diagPath(ctx: ReturnType<typeof fakeCtx>): string {
  return join(ctx.pacerHome, "state", "background-worker.json");
}
function readDiag(ctx: ReturnType<typeof fakeCtx>): { state?: string; restarts?: number; loops?: Record<string, { at: number; ok: boolean }>; managed?: string[] } | null {
  try { return JSON.parse(readFileSync(diagPath(ctx), "utf8")); } catch { return null; }
}
const outboxPath = (ctx: ReturnType<typeof fakeCtx>) => join(ctx.pacerHome, "link", "outbox.jsonl");
function readTaskId(ctx: ReturnType<typeof fakeCtx>): string {
  return listTasks(ctx, 1)[0]!.id;
}
function outboxHasTask(ctx: ReturnType<typeof fakeCtx>): boolean {
  return existsSync(outboxPath(ctx)) && readFileSync(outboxPath(ctx), "utf8").includes('"type":"task"');
}
async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not met within " + timeoutMs + "ms");
}
/** A strategy lets the worker's pump compute status and reach the per-task loop. */
function withStrategy(ctx: ReturnType<typeof fakeCtx>): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
}

test("periodic loops run in the background worker", async () => {
  const ctx = fakeCtx({ which: () => null });
  withStrategy(ctx);
  createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const server = startServer(() => ctx, { port: 0, listener: false, backgroundWorker: true, pumpMs: 25 });
  try {
    // A real worker is spawned and takes over the periodic loops.
    await waitFor(() => readDiag(ctx)?.state === "running");
    const diag = readDiag(ctx)!;
    // All six periodic loops are managed (and run) in the worker.
    for (const name of ["pump", "broker", "sweep", "certification", "usage", "observations"]) {
      expect(diag.managed).toContain(name);
    }
    // The pump actually executes off the request thread and publishes the new task.
    await waitFor(() => !!readDiag(ctx)?.loops?.pump?.at);
    await waitFor(() => outboxHasTask(ctx));
    expect(server.backgroundWorker()).toBeDefined();
  } finally { server.stop(); }
});

test("a blocked worker tick does not delay /health or a task.get", async () => {
  const ctx = fakeCtx({ which: () => null });
  withStrategy(ctx);
  for (let i = 0; i < 60; i++) {
    createTask(ctx, { brief: { goal: `g${i}`, repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  }
  const server = startServer(() => ctx, { port: 0, listener: false, backgroundWorker: true, pumpMs: 20 });
  await waitFor(() => readDiag(ctx)?.state === "running");
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { Authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...init,
    signal: AbortSignal.timeout(800),
  });
  try {
    // Let the worker run several pump rounds (real work over 60 tasks) meanwhile the request thread stays free.
    await Bun.sleep(250);
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const health = await request("/health");
      expect(health.status).toBe(200);
      expect(performance.now() - started).toBeLessThan(400);
    }
    const started = performance.now();
    const got = await request("/v3/ops/task.get", { method: "POST", body: JSON.stringify({ id: readTaskId(ctx) }) });
    expect(got.status).toBe(200);
    expect((await got.json()).result?.id).toBeDefined();
    expect(performance.now() - started).toBeLessThan(700);
  } finally { server.stop(); }
});

test("the worker restarts after it dies and diagnostics show it", async () => {
  const ctx = fakeCtx({ which: () => null });
  const server = startServer(() => ctx, { port: 0, listener: false, backgroundWorker: true, pumpMs: 0 });
  try {
    await waitFor(() => readDiag(ctx)?.state === "running");
    const worker = server.backgroundWorker();
    expect(worker).toBeDefined();
    worker!.terminate();
    await waitFor(() => {
      const diag = readDiag(ctx);
      return diag !== null && (diag.restarts ?? 0) >= 1 && diag.state === "running";
    }, 20000);
    expect(readDiag(ctx)!.restarts).toBeGreaterThanOrEqual(1);
  } finally { server.stop(); }
});

test("SSE wakes on a worker publish", async () => {
  const ctx = fakeCtx({ which: () => null });
  withStrategy(ctx);
  const server = startServer(() => ctx, { port: 0, listener: false, backgroundWorker: true, pumpMs: 25 });
  try {
    await waitFor(() => readDiag(ctx)?.state === "running");
    const response = await fetch(`http://127.0.0.1:${server.port}/v3/events`, {
      headers: { Authorization: `Bearer ${server.token}` },
      signal: AbortSignal.timeout(8000),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    createTask(ctx, { brief: { goal: "sse-target", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    let buffer = "";
    const deadline = Date.now() + 8000;
    let sawTask = false;
    while (Date.now() < deadline && !sawTask) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      sawTask = buffer.includes("event: task");
    }
    reader.cancel();
    expect(sawTask).toBe(true);
  } finally { server.stop(); }
});