import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { installFixture } from "../conformance/install";

// Shared harness for the native front door's plugin tests (ADR 0027).
export const front = process.env.PACER_TEST_FRONT_DOOR;
export const tsOwner = { nativeHost: "0" };
export const ownerOn = { nativeHost: "1" };

export type Home = { home: string; state: string; plugin: string; done(): void };

// Owner sockets must fit SUN_LEN (~104), so every home lives directly under /tmp;
// a deep home's `run/s<12-hex>.sock` cannot, and binds in the private per-user directory.
export function makeHome(deep = false): Home {
  const home = realpathSync(mkdtempSync("/tmp/pnh-"));
  const state = join(home, ...(deep ? ["d".repeat(90)] : []), ".pacer");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n# preserve this comment\n", { mode: 0o600 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  const plugin = installFixture("ui", join(state, "plugins"));
  return { home, state, plugin, done: () => rmSync(home, { recursive: true, force: true }) };
}

export type Options = { nativeHost?: string; hostSocket?: string; env?: Record<string, string> };

export function frontEnv(h: Home, forward: string, options: Options) {
  return {
    HOME: h.home, PACER_HOME: h.state, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", PACER_FORWARD_OPS: forward,
    ...(options.nativeHost !== undefined ? { PACER_NATIVE_PLUGIN_HOST: options.nativeHost } : {}),
    ...(options.hostSocket !== undefined ? { PACER_HOST_SOCKET: options.hostSocket } : {}),
    // Linux deep homes bind under $XDG_RUNTIME_DIR; macOS asks confstr instead.
    ...(process.env.XDG_RUNTIME_DIR !== undefined ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
    ...options.env,
  };
}

export type Reply = { text: string; line: string; json: any };

/** One `pacer api --stdio` connection, already negotiated to protocol 3. */
export async function stdio(h: Home, forward = "", options: Options = tsOwner, hello = true) {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: frontEnv(h, forward, options), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let stderr = "";
  const logs = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) stderr += decoder.decode(chunk, { stream: true });
    return stderr;
  })();
  const replies = new Map<string, string>();
  const waiters = new Map<string, { resolve(line: string): void; reject(error: Error): void }>();
  const order: string[] = [];
  // Set once stdout closes: why every unanswered request fails now instead of timing out.
  let closed: string | undefined;
  const pump = (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        const message = JSON.parse(line);
        if (!Object.hasOwn(message, "id")) continue;
        const key = JSON.stringify(message.id);
        order.push(key);
        const waiter = waiters.get(key);
        if (waiter) { waiters.delete(key); waiter.resolve(line); } else replies.set(key, line);
      }
    }
    await Promise.race([Promise.all([child.exited, logs]), Bun.sleep(2000)]);
    closed = `the door closed stdout (exit ${child.exitCode}); stderr:\n${stderr}`;
    for (const [key, waiter] of waiters) { waiters.delete(key); waiter.reject(Error(`no reply to ${key}: ${closed}`)); }
  })();
  let next = 1;
  const send = (line: string) => { child.stdin.write(`${line}\n`); child.stdin.flush(); };
  const reply = (id: unknown, timeout = 30000): Promise<Reply> => {
    const key = JSON.stringify(id);
    const settle = (line: string): Reply => {
      const prefix = `{"jsonrpc":"2.0","id":${key},`;
      expect(line.startsWith(prefix), line).toBe(true);
      return { line, text: line.slice(prefix.length, -1), json: JSON.parse(line) };
    };
    const ready = replies.get(key);
    if (ready !== undefined) { replies.delete(key); return Promise.resolve(settle(ready)); }
    if (closed !== undefined) return Promise.reject(Error(`no reply to ${key}: ${closed}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(key);
        reject(Error(`no reply to ${key} in ${timeout} ms; stderr so far:\n${stderr}`));
      }, timeout);
      waiters.set(key, {
        resolve: line => { clearTimeout(timer); resolve(settle(line)); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  };
  const call = (method: string, params: unknown, id: unknown = next++) => {
    send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return reply(id);
  };
  if (hello) expect((await call("hello", { protocol: 3 })).json.result.protocol).toBeDefined();
  return { child, send, reply, call, order, async stop() {
    child.stdin.end();
    const exited = await Promise.race([child.exited, Bun.sleep(20000).then(() => "hung")]);
    if (exited === "hung") { child.kill("SIGKILL"); await child.exited; }
    await pump;
    return await logs;
  } };
}

/** A port nothing listens on right now. */
export function freePort(): number {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  return port;
}

/** `pacer serve` on an existing home, not yet known to be up. */
export function spawnServe(h: Home, forward = "", options: Options = tsOwner, port = freePort()) {
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: frontEnv(h, forward, options), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let text = "";
  const logs = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) text += decoder.decode(chunk, { stream: true });
    return text;
  })();
  /** Stderr so far, while the serve runs. */
  const stderr = () => text;
  return { child, port, logs, stderr };
}

/** A flag-controlled serve on an existing home. */
export async function serve(h: Home, forward = "", options: Options = tsOwner) {
  const { child, port, logs } = spawnServe(h, forward, options);
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let i = 0; i < 500; i++) {
    try {
      token = readFileSync(join(h.state, "token"), "utf8").trim();
      if ((await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* Wait for this child only. */ }
    if (child.exitCode !== null) throw Error(await logs);
    await Bun.sleep(20);
  }
  const call = async (op: string, params: unknown): Promise<Reply> => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(30000) });
    const line = await response.text();
    return { line, text: line.slice(1, -1), json: JSON.parse(line) };
  };
  return { child, call, async stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    return await logs;
  } };
}

export const normalize = (h: Home, text: string) => text.replaceAll(h.home, "<HOME>")
  .replace(/"renderedAt":\d+/g, '"renderedAt":0').replace(/"pid":\d+/g, '"pid":0').replace(/"uptimeS":[\d.]+/g, '"uptimeS":0');

/** The code, message and hint both envelopes carry; JSON-RPC errors omit HTTP's error data. */
export function semantic(reply: Reply) {
  const error = reply.json.error;
  if (!error) return reply.json.result;
  const http = typeof error.code === "string";
  const hint = http ? error.hint : error.data?.hint;
  return { code: http ? error.code : error.data?.code, message: error.message, ...(hint ? { hint } : {}) };
}

// A plugin child records whether it inherited the private key, and every start.
export const recordingMain = `#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
appendFileSync('starts', process.pid + '\\n');
writeFileSync('inherited-key', process.env.PACER_NATIVE_CONFIG_SYNC_KEY ?? 'absent');
// @ts-ignore: installFixture copies the shared plugin.ts beside this entry point.
await import('./plugin');
`;
export const starts = (h: Home) => existsSync(join(h.plugin, "starts")) ? readFileSync(join(h.plugin, "starts"), "utf8").trim().split("\n").map(line => Number(line.split(" ")[0])) : [];
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
