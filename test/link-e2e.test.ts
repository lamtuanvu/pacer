import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { get as nodeGet } from "node:http";
import { join } from "node:path";
import { createPlugin } from "../orca-plugin/src/plugin";
import type { OrcaHost, OrcaWorkerContext } from "../orca-plugin/src/orca-api";
import { contentKey, decodeCmdLine, summaryLine } from "../src/link/envelope";
import { pluginDataDir } from "../src/link/paths";
import { pumpOnce } from "../src/link/pump";
import { runConsole } from "../src/console/console";
import { writeConsole } from "../src/link/store";
import { publish } from "../src/link/publish";
import { refreshBridge } from "../src/link/publish";
import { startServer } from "../src/serve/http";
import { httpTransport } from "../orca-plugin/src/transports/http";
import { bridgeTransport } from "../orca-plugin/src/transports/bridge";
import { LinkStore } from "../orca-plugin/src/store";
import { pluginCli } from "../src/plugin/cli";
import type { Status } from "../src/engine/status";
import type { TaskRecord } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";
import { fakeRun } from "./fixtures/orca/fake";
import type { Timers } from "../orca-plugin/src/plugin";

class TestTimers implements Timers {
  jobs: { ms: number; fn: () => void; interval: boolean; cancelled: boolean }[] = [];
  every(ms: number, fn: () => void) { const job = { ms, fn, interval: true, cancelled: false }; this.jobs.push(job); return () => { job.cancelled = true; }; }
  after(ms: number, fn: () => void) { const job = { ms, fn, interval: false, cancelled: false }; this.jobs.push(job); return () => { job.cancelled = true; }; }
  async advance(ms: number) { for (const j of [...this.jobs]) if (!j.cancelled && j.ms <= ms) { if (!j.interval) j.cancelled = true; j.fn(); await flush(); } }
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

test("HTTP and installed storage bridge converge on the same envelopes", async () => {
  const home = tmpDir(), userData = join(home, "orca-data");
  const fake = fakeRun([]);
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PACER_BIN: "/opt/pacer", PACER_ORCA_USER_DATA: userData }, run: fake.run });
  await pluginCli(["install"], ctx);
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  refreshBridge(ctx);
  const storage = join(pluginDataDir(ctx), "storage.json");
  const host = { call: async () => ({ value: JSON.parse(readFileSync(storage, "utf8")).link }) } as unknown as OrcaHost;
  const server = startServer(() => ctx, { port: 0, tailMs: 20, pumpMs: 0 });
  const timers = {
    every: (ms: number, fn: () => void) => { const t = setInterval(fn, ms); return () => clearInterval(t); },
    after: (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
  };
  const request = (url: string, token: string, timeoutMs: number) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = nodeGet(url, { headers: { Authorization: `Bearer ${token}` } }, res => { let body = ""; res.setEncoding("utf8"); res.on("data", chunk => body += chunk); res.on("end", () => resolve({ status: res.statusCode ?? 0, body })); });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout"))); req.on("error", reject);
  });
  const stream = (url: string, token: string, onLine: (line: string) => void, onClose: (error?: Error) => void) => {
    const req = nodeGet(url, { headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" } }, res => {
      res.setEncoding("utf8"); let buffer = "";
      res.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { onLine(buffer.slice(0, i).replace(/\r$/, "")); buffer = buffer.slice(i + 1); } });
      res.on("error", onClose); res.on("end", () => onClose());
    });
    req.on("error", onClose); return () => req.destroy();
  };
  const http = httpTransport({ http: { get: request, stream }, readToken: () => server.token, port: server.port, timers });
  const bridge = bridgeTransport({ host, pollMs: 20, timers });
  const a = new LinkStore(() => ctx.now), b = new LinkStore(() => ctx.now);
  try {
    a.replace((await http.snapshot())!); b.replace((await bridge.snapshot())!);
    const stopA = http.watch(e => a.apply(e), s => a.replace(s));
    const stopB = bridge.watch(() => {}, s => b.replace(s));
    await new Promise(resolve => setTimeout(resolve, 50));
    await publish(ctx, [
      { v: 1, type: "budget", data: { generatedAt: ctx.now, strategy: "default", planner: "claude-code", mode: "normal", providers: [], ranked: [] } },
      { v: 1, type: "task", data: { id: "e2e-task", state: "running", goal: "running task", executor: "codex", backend: "direct", worktree: null, updatedAt: ctx.now } },
      { v: 1, type: "task", data: { id: "e2e-task", state: "done", goal: "running task", executor: "codex", backend: "direct", worktree: null, updatedAt: ctx.now + 1 } },
      { v: 1, type: "alert", data: { key: "e2e-alert", level: "warn", title: "converged", body: "done", at: ctx.now + 1 } },
    ], { channel: false });
    const until = Date.now() + 2000;
    while (Date.now() < until && contentKey(a.snapshot) !== contentKey(b.snapshot)) await new Promise(resolve => setTimeout(resolve, 20));
    expect(contentKey(a.snapshot)).toBe(contentKey(b.snapshot));
    expect(a.snapshot.tasks[0]?.state).toBe("done");
    expect(fake.calls).toEqual([]);
    stopA(); stopB();
  } finally { server.stop(); }
});

test("installed bridge connects pump snapshots and plugin console commands", async () => {
  const home = tmpDir(), userData = join(home, "orca-data"), timers = new TestTimers();
  const fake = fakeRun([]);
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer"), env: { PACER_BIN: "/opt/pacer", PACER_ORCA_USER_DATA: userData }, run: fake.run });
  expect((await pluginCli(["install"], ctx)).code).toBe(0);
  const status = { generatedAt: ctx.now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } } as unknown as Status;
  const task: TaskRecord = { id: "t-1", createdAt: ctx.now, kind: null, requestedExecutor: null, timeoutS: 60, brief: { goal: "ship feature", repo: "/wt/feat-x" }, state: "running", attempts: [{ executor: "codex", model: null, startedAt: ctx.now, endedAt: ctx.now, exitCode: 0, timedOut: false, limitHit: false, log: "" }] };
  writeConsole(ctx, { handle: "term_x", paneKey: "pane", pid: process.pid, startedAt: ctx.now, heartbeatAt: ctx.now });
  await pumpOnce(ctx, { status: async () => status, tasks: () => [task], publish: async (c, es) => { const { publish } = await import("../src/link/publish"); return publish(c, es, { channel: false }); } });
  const storage = join(pluginDataDir(ctx), "storage.json");
  const calls: { method: string; params: any }[] = [], handlers = new Map<string, (p?: unknown) => unknown>(), events = new Map<string, (p: unknown) => unknown>();
  let sent = "";
  const host = { call: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "settings.get") return { settings: { transport: "bridge", pollSeconds: 5 } };
    if (method === "storage.get") return { value: JSON.parse(readFileSync(storage, "utf8")).link };
    if (method === "workspace.readContext") return { branch: "feat-x", displayName: "feat-x", terminals: [{ id: "term_x" }] };
    if (method === "terminal.sendText") { sent = params.text; return { accepted: true }; }
    return { delivered: true };
  } } as OrcaHost;
  const root = join(ctx.pacerHome, "orca-plugin");
  const plugin = createPlugin({ nowS: () => ctx.now, timers, home, pluginRoot: root, http: { get: async () => ({ status: 401, body: "" }), stream: () => () => {} }, fs: { readText: () => "token", exists: p => existsSync(p), writeTextAtomic: (path, text) => { const tmp = `${path}.tmp`; writeFileSync(tmp, text); renameSync(tmp, path); } } });
  const worker: OrcaWorkerContext = { host, commands: { register: (id, handler) => handlers.set(id, handler) }, events: { on: (id, handler) => events.set(id, handler) }, grantedCapabilities: [], log: () => {} };
  try {
    await plugin.activate(worker); await flush();
    const stored = JSON.parse(readFileSync(storage, "utf8")).link;
    expect(stored.tasks[0].goal).toBe("ship feature");
    await timers.advance(2000);
    expect(readFileSync(join(root, "panel/live.html"), "utf8")).toContain(summaryLine(stored.budget));
    await handlers.get("delegate")!();
    expect(decodeCmdLine(sent).cmd?.data).toEqual({ cmd: "delegate", branch: "feat-x", displayName: "feat-x" });
    const userKeys = Object.keys(JSON.parse(readFileSync(storage, "utf8")));
    expect(userKeys).toContain("link");
    const delegated: unknown[] = [];
    const consoleDeps = {
      delegate: (_ctx: typeof ctx, input: unknown) => { delegated.push(input); return task; },
      useStrategy: () => "", listStrategies: () => [], statusText: async () => "", pump: async () => [],
      heartbeat: () => {}, resolveWorktreePath: async () => "/wt/feat-x", selfHandle: async () => ({ handle: "term_x", paneKey: "pane" }),
      every: () => () => {}, pid: process.pid, cwd: home,
    };
    await runConsole(ctx, { lines: (async function* () { yield sent; yield "ship it"; yield ""; yield ""; yield ""; yield "feature"; yield "quit"; })(), write: () => {} }, consoleDeps);
    expect(delegated).toEqual([{ brief: { goal: "ship it", repo: "/wt/feat-x" }, kind: "feature" }]);
    await events.get("agent.status.changed")!({ worktreeId: "wt", paneKey: "pane-done", state: "done", receivedAt: ctx.now });
    const doneLine = sent;
    expect(decodeCmdLine(doneLine).cmd?.data).toEqual({ cmd: "agent-done", paneKey: "pane-done", worktreeId: "wt" });
    let pumps = 0;
    await runConsole(ctx, { lines: (async function* () { yield doneLine; yield "quit"; })(), write: () => {} }, { ...consoleDeps, pump: async () => { pumps++; return []; } });
    expect(pumps).toBe(1);
    expect(fake.calls).toEqual([]);
  } finally { await plugin.deactivate(); }
});
