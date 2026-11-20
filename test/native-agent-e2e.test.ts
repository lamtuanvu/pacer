/**
 * The agent ops `agent.preview`, `agent.connect`, `agent.undo` and `agent.disconnect` through the real Rust
 * front doors (`pacer serve`, `pacer api --stdio`) and the real Core agent-effects bridge, against the test
 * core in fixtures/agent-core.ts: a seeded strategy and a fake CLI produce a deterministic file plan, all in a
 * disposable HOME. Each scenario runs natively and with the agent ops in PACER_FORWARD_OPS; the replies must
 * match. The front door is a test-ops build. Every child, and the core each front door starts, gets
 * PACER_PORT: its own server port or a closed one, never 4317.
 */
import {afterAll, describe, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {join} from "node:path";
import {closedPort, pinnedEnv, REAL_SERVICE_PORT} from "./isolated-port";

const CLOSED = String(closedPort());
const CORE = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/agent-core.ts")]);
const FORWARD = "agent.preview,agent.connect,agent.undo,agent.disconnect";
const LONG = 300_000;

/**
 * The agent results embed the disposable home path (which differs per run) and a revision hash that is
 * derived from those same paths as file content. To compare a native run against a forwarded run we
 * must normalise both: every occurrence of the run's home path becomes a stable literal, and every
 * `result.revision` (and the `undo` / `installed` / `removed` / `files` / `changes[].path` arrays
 * that already carry the path through the path replacement) becomes deterministic.
 */
function normalise(record: Record<string, unknown>, home: string): Record<string, unknown> {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") {
      return value.split(home).join("$HOME").replace(/\b[0-9a-f]{64}\b/g, "$HASH");
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = key === "revision" && typeof item === "string" ? "$HASH" : replace(item);
      return out;
    }
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = replace(value);
  return out;
}

/** Replace all known homes in a JSON-RPC line (executor and granted connections can have their own). */
function normaliseAcross(run: {out: Record<string, unknown>; homes: string[]}) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(run.out)) {
    const raw = String(value);
    try {
      let parsed: unknown = JSON.parse(raw);
      for (const home of run.homes) {
        const wrapped = normalise({_: parsed}, home);
        parsed = (wrapped as Record<string, unknown>)._;
      }
      out[key] = JSON.stringify(parsed);
    } catch { out[key] = raw; }
  }
  return out;
}

let binary = process.env.PACER_TEST_NATIVE_FRONT_DOOR ?? "";
function frontDoor() {
  if (!binary) {
    const env = pinnedEnv({...process.env, PACER_PORT: CLOSED});
    execFileSync("cargo", ["build", "-q", "-p", "pacer", "--locked", "--features", "test-ops"], {stdio: "inherit", env});
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {env}).toString());
    binary = join(metadata.target_directory, "debug/pacer");
  }
  return binary;
}

const homes: string[] = [];
const children: Array<{kill(): void}> = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const home of homes) rmSync(home, {recursive: true, force: true});
});

function newHome() {
  const home = mkdtempSync("/tmp/agente2e-");
  homes.push(home);
  mkdirSync(join(home, ".pacer"), {mode: 0o700});
  return home;
}

function sandbox(forward?: string, extra: Record<string, string> = {}, home = newHome()) {
  const pacerHome = join(home, ".pacer");
  const env: Record<string, string> = {
    HOME: home, PACER_HOME: pacerHome, PATH: process.env.PATH ?? "/usr/bin:/bin", PACER_CORE_ARGV: CORE,
    PACER_BACKEND: "direct", PACER_ORCA_USER_DATA: join(home, "orca"), PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", PACER_PORT: CLOSED, ...(forward ? {PACER_FORWARD_OPS: forward} : {}), ...extra,
  };
  return {home, pacerHome, env: pinnedEnv(env)};
}

function drain(stream: ReadableStream<Uint8Array>) {
  const sink = {text: "", done: Promise.resolve()};
  sink.done = (async () => { const decoder = new TextDecoder(); for await (const chunk of stream) sink.text += decoder.decode(chunk, {stream: true}); })();
  return sink;
}

async function until(check: () => boolean, what: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address() as {port: number};
      server.close(() => resolve(port));
    });
  });
}

async function serve(forward?: string, home?: string, extra: Record<string, string> = {}) {
  const port = await freePort();
  const box = sandbox(forward, {...extra, PACER_PORT: String(port)}, home);
  rmSync(join(box.pacerHome, "core-ready"), {force: true});
  const child = Bun.spawn([frontDoor(), "serve", "--port", String(port)], {env: box.env, cwd: box.home, stdout: "ignore", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  await until(() => existsSync(join(box.pacerHome, "core-ready")) && existsSync(join(box.pacerHome, "token")), "pacer serve and its core");
  const token = readFileSync(join(box.pacerHome, "token"), "utf8").trim();
  const origin = `http://127.0.0.1:${port}`;
  const session = randomBytes(32).toString("hex");
  mkdirSync(join(box.pacerHome, "app"), {mode: 0o700, recursive: true});
  writeFileSync(join(box.pacerHome, "app/sessions.json"), JSON.stringify([{hash: createHash("sha256").update(session).digest("hex"), expiresAt: Date.now() / 1000 + 3600}]));
  const request = async (path: string, body: unknown, headers: Record<string, string> = {authorization: `Bearer ${token}`}, signal?: AbortSignal) => {
    const response = await fetch(`${origin}${path}`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify(body), signal});
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch {}
    return {status: response.status, body: parsed};
  };
  return {
    ...box, port, child, stderr, token,
    op: (name: string, params: unknown, headers?: Record<string, string>, signal?: AbortSignal) => request(`/v3/ops/${name}`, params, headers, signal),
    request,
    cookie: (withOrigin: boolean) => ({cookie: `pacer_session=${session}`, ...(withOrigin ? {origin, "x-pacer-client": "app"} : {})}),
    stop: async () => { child.kill(); await child.exited; await stderr.done; },
  };
}

function connect(forward?: string, extra: Record<string, string> = {}, home?: string) {
  const box = sandbox(forward, extra, home);
  const child = Bun.spawn([frontDoor(), "api", "--stdio"], {env: box.env, cwd: box.home, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  const replies = new Map<number, unknown>();
  const lines = new Map<number, string>();
  const waiting = new Map<number, (reply: unknown) => void>();
  const order: number[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, {stream: true});
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (typeof message.id !== "number") continue;
        const {jsonrpc: _, ...reply} = message;
        order.push(message.id);
        lines.set(message.id, line);
        replies.set(message.id, reply);
        waiting.get(message.id)?.(replies.get(message.id));
      }
    }
  })();
  let next = 1;
  const call = (method: string, params: unknown = {}) => {
    const id = next++;
    const reply = new Promise<any>(resolve => waiting.set(id, resolve));
    child.stdin.write(`${JSON.stringify({jsonrpc: "2.0", id, method, params})}\n`);
    child.stdin.flush();
    return reply;
  };
  return {
    ...box, stderr, order, call,
    line: (id: number) => lines.get(id),
    close: async () => { child.stdin.end(); await child.exited; await stderr.done; },
  };
}

describe("each front door hands its pinned PACER_PORT to every core it starts", () => {
  test("serve and stdio front doors let agent calls reach Core", async () => {
    expect(CLOSED).not.toBe(REAL_SERVICE_PORT);
    const server = await serve();
    await server.stop();
    const rpc = connect();
    await rpc.call("hello", {protocol: 3});
    await rpc.close();
  }, LONG);
});

describe("HTTP front door", () => {
  async function scenario(server: Awaited<ReturnType<typeof serve>>) {
    const out: Record<string, unknown> = {};
    out.preview = await server.op("agent.preview", {agent: "codex"});
    out.previewMissing = await server.op("agent.preview", {});
    out.previewBad = await server.op("agent.preview", {agent: "wat"});
    out.connectNoConsent = await server.op("agent.connect", {agent: "codex"});
    out.connect = await server.op("agent.connect", {agent: "codex", consent: true});
    out.undo = await server.op("agent.undo", {agent: "codex", consent: true});
    out.disconnect = await server.op("agent.disconnect", {agent: "codex"});
    out.connectArray = await server.op("agent.connect", []);
    out.previewNull = await server.op("agent.preview", null);
    out.cookie = await server.op("agent.preview", {agent: "codex"}, server.cookie(true));
    out.cookieNoOrigin = await server.op("agent.preview", {agent: "codex"}, server.cookie(false));
    out.unauthenticated = await server.op("agent.connect", {agent: "codex", consent: true}, {});
    out.workGrant = await server.op("agent.connect", {agent: "codex", consent: true}, {authorization: `Bearer pwg_${"ab".repeat(32)}`});
    out.externalBridge = await server.request("/_internal/agent-effects", {request: {kind: "connect", params: {agent: "codex", consent: true}}});
    return out;
  }

  test("native replies, refusals, errors, identity and the bridge effect match the forwarded path", async () => {
    const native = await serve();
    const nativeResults = await scenario(native);
    await native.stop();
    const forwarded = await serve(FORWARD);
    const forwardedResults = await scenario(forwarded);
    await forwarded.stop();

    expect(normalise(nativeResults, native.home)).toEqual(normalise(forwardedResults, forwarded.home));
    for (const op of ["agent.preview", "agent.connect", "agent.undo", "agent.disconnect"]) {
      expect(native.stderr.text, op).toContain(`native ${op}`);
      expect(forwarded.stderr.text, op).not.toContain(`native ${op}`);
    }

    const r = nativeResults as Record<string, any>;
    expect(r.preview.body.result.files).toContain(join(native.home, ".codex/skills/pacer/SKILL.md"));
    expect(r.preview.body.result.undo).toBe("pacer uninstall codex");
    expect(r.previewMissing.body.error.code).toBe("invalid_input");
    expect(r.previewBad.body.error.code).toBe("invalid_input");
    expect(r.connectNoConsent.body.error.code).toBe("not_allowed");
    expect(r.connect.body.result.installed.length).toBeGreaterThan(0);
    expect(r.undo.body.error.code).toBe("conflict");
    expect(r.disconnect.body.result.removed.length).toBeGreaterThan(0);
    expect(r.connectArray.body.error.code).toBe("invalid_input");
    expect(r.previewNull.body.error.code).toBe("invalid_input");
    expect(r.cookie).toEqual(r.preview);
    expect(r.cookieNoOrigin.status).toBe(403);
    expect(r.unauthenticated.status).toBe(401);
    expect(r.workGrant.status).toBeGreaterThanOrEqual(400);
    expect(r.externalBridge.status).toBe(404);
  }, LONG);
});

describe("stdio front door", () => {
  /** A full bridge flow on a fresh home, over stdio: preview, connect, undo, disconnect and refusals. */
  async function scenario(rpc: ReturnType<typeof connect>) {
    const out: Record<string, unknown> = {};
    const capture = async (method: string, params: unknown) => {
      const {id} = await rpc.call(method, params);
      out[`${method} ${JSON.stringify(params)}`] = rpc.line(id);
    };
    await capture("agent.preview", {agent: "codex"});
    await capture("agent.preview", {});
    await capture("agent.connect", {agent: "codex"});
    await capture("agent.connect", {agent: "codex", consent: true});
    await capture("agent.undo", {agent: "codex", consent: true});
    await capture("agent.disconnect", {agent: "codex"});
    await capture("agent.connect", []);
    await capture("agent.preview", null);
    return out;
  }

  test("native replies, refusals, errors and identity match the forwarded path; executors are refused", async () => {
    async function run(forwarded: boolean) {
      const out: Record<string, unknown> = {};
      const traces: string[] = [];
      const rpc = connect(forwarded ? FORWARD : undefined);
      expect((await rpc.call("hello", {protocol: 3})).result.protocol).toStartWith("3.");
      Object.assign(out, await scenario(rpc));

      const executor = connect(forwarded ? FORWARD : undefined, {PACER_ROLE: "executor"});
      await executor.call("hello", {protocol: 3});
      out.executorPreview = executor.line((await executor.call("agent.preview", {agent: "codex"})).id);
      out.executorConnect = executor.line((await executor.call("agent.connect", {agent: "codex", consent: true})).id);
      out.executorUndo = executor.line((await executor.call("agent.undo", {agent: "codex", consent: true})).id);
      out.executorDisconnect = executor.line((await executor.call("agent.disconnect", {agent: "codex"})).id);

      const granted = connect(forwarded ? FORWARD : undefined, {PACER_WORK_GRANT: `pwg_${"ab".repeat(32)}`});
      await granted.call("hello", {protocol: 3});
      out.grantConnect = granted.line((await granted.call("agent.connect", {agent: "codex", consent: true})).id);
      out.grantPreview = granted.line((await granted.call("agent.preview", {agent: "codex"})).id);

      await rpc.close();
      await executor.close();
      await granted.close();
      traces.push(rpc.stderr.text, executor.stderr.text, granted.stderr.text);
      return {out, traces, homes: [rpc.home, executor.home, granted.home]};
    }

    const native = await run(false);
    const forwarded = await run(true);
    expect(normaliseAcross(native)).toEqual(normaliseAcross(forwarded));

    const [session, executor, granted] = native.traces;
    expect(session).toMatch(/native agent\.(preview|connect|undo|disconnect)/);
    expect(executor).toMatch(/native agent\.(preview|connect|undo|disconnect)/);
    expect(granted).not.toMatch(/native agent\.(preview|connect|undo|disconnect)/);
    for (const trace of forwarded.traces) expect(trace).not.toMatch(/native agent\.(preview|connect|undo|disconnect)/);

    const r = native.out as Record<string, any>;
    expect(JSON.parse(r["agent.preview {\"agent\":\"codex\"}"]!).result.files).toContain(join(native.homes[0], ".codex/skills/pacer/SKILL.md"));
    for (const key of ["agent.preview {}", "agent.connect []", "agent.preview null"]) expect(JSON.parse(r[key]!).error.data.code).toBe("invalid_input");
    expect(JSON.parse(r["agent.connect {\"agent\":\"codex\"}"]!).error.data.code).toBe("not_allowed");
    expect(r.executorPreview && JSON.parse(r.executorPreview!).result).toBeDefined();
    for (const key of ["executorConnect", "executorUndo", "executorDisconnect"]) expect(JSON.parse(r[key]!).error.data.code).toBe("not_allowed");
    // A work-grant session is a forwarded session whose ops Core scopes; both agent ops are errors there.
    for (const key of ["grantConnect", "grantPreview"]) expect(JSON.parse(r[key]!).error).toBeDefined();
  }, LONG);
});