import { expect, test } from "bun:test";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { installFixture } from "../conformance/install";
import { callOp } from "../src/api/ops";
import { runStdio } from "../src/api/stdio";
import { pluginNativeRequest } from "../src/serve/plugin-native";
import { fakeCtx } from "./helpers";

// The stdio front door answers the twelve plugin operations natively (ADR 0027).
const front = process.env.PACER_TEST_FRONT_DOOR;
const context = { route: "overview", theme: "light" };
const OPS = [
  "plugin.list", "plugin.doctor", "plugin.ui.list", "plugin.settings.get",
  "plugin.enable", "plugin.disable", "plugin.remove", "plugin.ui.render",
  "plugin.ui.action", "plugin.ui.visibility", "plugin.settings.set", "plugin.install",
];
const tsOwner = { nativeHost: "0" };
const ownerOn = { nativeHost: "1" };

type Home = { home: string; state: string; plugin: string; done(): void };

// Owner sockets must fit SUN_LEN (~104), so every home lives directly under /tmp;
// a deep home's `run/s<12-hex>.sock` cannot, and binds in the private per-user directory.
function makeHome(deep = false): Home {
  const home = realpathSync(mkdtempSync("/tmp/pnh-"));
  const state = join(home, ...(deep ? ["d".repeat(90)] : []), ".pacer");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n# preserve this comment\n", { mode: 0o600 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  const plugin = installFixture("ui", join(state, "plugins"));
  return { home, state, plugin, done: () => rmSync(home, { recursive: true, force: true }) };
}

type Options = { nativeHost?: string; hostSocket?: string };

function frontEnv(h: Home, forward: string, options: Options) {
  return {
    HOME: h.home, PACER_HOME: h.state, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
    PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1", PACER_FORWARD_OPS: forward,
    ...(options.nativeHost !== undefined ? { PACER_NATIVE_PLUGIN_HOST: options.nativeHost } : {}),
    ...(options.hostSocket !== undefined ? { PACER_HOST_SOCKET: options.hostSocket } : {}),
  };
}

type Reply = { text: string; line: string; json: any };

/** One `pacer api --stdio` connection, already negotiated to protocol 3. */
async function stdio(h: Home, forward = "", options: Options = tsOwner, hello = true) {
  const child = Bun.spawn([front!, "api", "--stdio"], { env: frontEnv(h, forward, options), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const logs = new Response(child.stderr).text();
  const replies = new Map<string, string>(), waiters = new Map<string, (line: string) => void>();
  const order: string[] = [];
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
        if (waiter) { waiters.delete(key); waiter(line); } else replies.set(key, line);
      }
    }
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`no reply to ${key}`)), timeout);
      waiters.set(key, line => { clearTimeout(timer); resolve(settle(line)); });
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

/** A flag-controlled serve on an existing home. */
async function serve(h: Home, forward = "", options: Options = tsOwner) {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], { env: frontEnv(h, forward, options), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const logs = new Response(child.stderr).text();
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
  return { call, async stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    return await logs;
  } };
}

const normalize = (h: Home, text: string) => text.replaceAll(h.home, "<HOME>")
  .replace(/"renderedAt":\d+/g, '"renderedAt":0').replace(/"pid":\d+/g, '"pid":0').replace(/"uptimeS":[\d.]+/g, '"uptimeS":0');

/** The code, message and hint both envelopes carry; JSON-RPC errors omit HTTP's error data. */
function semantic(reply: Reply) {
  const error = reply.json.error;
  if (!error) return reply.json.result;
  const http = typeof error.code === "string";
  const hint = http ? error.hint : error.data?.hint;
  return { code: http ? error.code : error.data?.code, message: error.message, ...(hint ? { hint } : {}) };
}

async function sequence(h: Home, call: (op: string, params: unknown) => Promise<Reply>) {
  const out: Reply[] = [];
  out.push(await call("plugin.list", {}));
  out.push(await call("plugin.enable", { id: "fx-ui" }));
  out.push(await call("plugin.enable", { id: "fx-ui", grant: true }));
  out.push(await call("plugin.ui.list", {}));
  for (const op of ["plugin.ui.render", "plugin.ui.action", "plugin.ui.visibility"]) {
    out.push(await call(op, { plugin: "fx-ui", surface: "activity", id: "missing", context, action: "run", requestId: "r", visible: false, expect_rev: 0 }));
  }
  out.push(await call("plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context }));
  out.push(await call("plugin.settings.get", { plugin: "fx-ui" }));
  out.push(await call("plugin.settings.set", { plugin: "fx-ui", values: { required: "yes", nope: 1 }, expect_rev: 0 }));
  const save = { plugin: "fx-ui", values: { required: true, items: ["a", "b"] }, expect_rev: 0 };
  out.push(await call("plugin.settings.set", save), await call("plugin.settings.set", save));
  const visibility = { plugin: "fx-ui", surface: "activity", id: "checklist", visible: false, expect_rev: 1 };
  out.push(await call("plugin.ui.visibility", visibility), await call("plugin.ui.visibility", visibility));
  out.push(await call("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context }));
  out.push(await call("plugin.ui.action", { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "run", requestId: "r1" }));
  out.push(await call("plugin.doctor", { id: "fx-ui" }));
  out.push(await call("plugin.disable", { id: "fx-ui" }));
  out.push(await call("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context }));
  out.push(await call("plugin.remove", { id: "fx-ui" }));
  out.push(await call("plugin.enable", { id: "fx-ui" }));
  out.push(await call("plugin.install", {}));
  for (const params of [null, [], { plugin: "Bad" }, { plugin: "fx-ui", values: {}, expect_rev: 1.5 }]) out.push(await call("plugin.settings.set", params));
  expect(readFileSync(join(h.state, "strategy.yaml"), "utf8")).toContain("# preserve this comment");
  expect(statSync(join(h.state, "plugin-settings.json")).mode & 0o777).toBe(0o600);
  return { replies: out, settings: readFileSync(join(h.state, "plugin-settings.json"), "utf8") };
}

test.skipIf(!front)("stdio answers all twelve plugin ops natively, matching forced forwarding and HTTP", async () => {
  const runs: Record<string, { h: Home; replies: Reply[]; settings: string }> = {};
  try {
    for (const [name, forward] of [["native", ""], ["forward", "*"]] as const) {
      const h = makeHome(), s = await stdio(h, forward);
      try { runs[name] = { h, ...await sequence(h, s.call) }; }
      finally {
        const log = await s.stop();
        if (forward) expect(log).not.toMatch(/^native plugin\./m);
        else for (const op of OPS) expect(log).toMatch(new RegExp(`^native ${op.replaceAll(".", "\\.")} \\d+$`, "m"));
      }
    }
    const h = makeHome(), s = await serve(h);
    try { runs.http = { h, ...await sequence(h, s.call) }; } finally { await s.stop(); }
    const text = (name: string) => runs[name].replies.map(r => normalize(runs[name].h, r.text));
    // Forced forwarding is the TypeScript golden for every byte on the stdio wire.
    expect(text("native")).toEqual(text("forward"));
    expect(runs.native.settings).toBe(runs.forward.settings);
    // HTTP and stdio carry the same result bytes; errors differ only in envelope.
    // Serve's background usage refresh starts the bundled usage plugin; stdio has no such loop.
    const own = (h: Home, reply: Reply) => normalize(h, JSON.stringify(reply.json.result.plugins.filter((p: any) => !p.bundled)));
    runs.native.replies.forEach((reply, i) => {
      const http = runs.http.replies[i];
      if (reply.json.result?.plugins) expect(own(runs.native.h, reply)).toBe(own(runs.http.h, http));
      else if (reply.json.result !== undefined) expect(normalize(runs.native.h, reply.text)).toBe(normalize(runs.http.h, http.text));
      else expect(semantic(reply)).toEqual(semantic(http));
    });
    expect(runs.native.settings).toBe(runs.http.settings);
  } finally { for (const run of Object.values(runs)) run.h.done(); }
}, 180000);

test.skipIf(!front)("PACER_FORWARD_OPS keeps individual plugin ops in TypeScript", async () => {
  const h = makeHome(), s = await stdio(h, "plugin.list,plugin.ui.render");
  try {
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await s.call("plugin.list", {})).json.result.plugins.some((p: any) => p.id === "fx-ui")).toBe(true);
    // TypeScript's renderer serves a running plugin only; native doctor starts it.
    await s.call("plugin.doctor", { id: "fx-ui" });
    expect((await s.call("plugin.ui.render", { plugin: "fx-ui", surface: "status", id: "open-items", context })).json.error).toBeUndefined();
  } finally {
    const log = await s.stop(); h.done();
    expect(log).toContain("native plugin.enable");
    expect(log).not.toContain("native plugin.list");
    expect(log).not.toContain("native plugin.ui.render");
  }
}, 60000);

test.skipIf(!front)("before hello v3 plugin ops stay with TypeScript", async () => {
  const h = makeHome(), s = await stdio(h, "", tsOwner, false);
  try {
    expect((await s.call("plugin.list", {}, 7)).json.error).toMatchObject({ data: { code: "unknown_op", hint: "plugin.list requires protocol 3" } });
    await s.call("hello", { protocol: 3 }, 8);
    expect((await s.call("plugin.list", {}, 9)).json.result.plugins.some((p: any) => p.id === "fx-ui")).toBe(true);
  } finally {
    const log = await s.stop(); h.done();
    expect(log).not.toContain("native plugin.list 7");
    expect(log).toContain("native plugin.list 9");
  }
}, 60000);

test.skipIf(!front)("request nesting at the 512-level budget, replayed reads and deep renders", async () => {
  const h = makeHome(), s = await stdio(h);
  try {
    // The line's envelope is one level: params holds 510 or 511 more, a total of 512 or 513.
    const line = (id: number, levels: number) => `{"jsonrpc":"2.0","id":${id},"method":"plugin.list","params":{"x":${"[".repeat(levels)}${"]".repeat(levels)}}}`;
    s.send(line(512, 510)); s.send(line(513, 511));
    for (const id of [512, 513]) expect((await s.reply(id)).json.result.plugins.some((p: any) => p.id === "fx-ui")).toBe(true);
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    const deep = "[".repeat(2000) + "0" + "]".repeat(2000);
    writeFileSync(join(h.state, "plugin-settings.json"), `{"fx-ui":{"rev":9,"values":{"deep":${deep}}}}`);
    const read = await s.call("plugin.settings.get", { plugin: "fx-ui" }, 600);
    expect(read.json.result.rev).toBe(9);
    expect(JSON.stringify(read.json.result.values.deep)).toBe(deep);
    writeFileSync(join(h.state, "plugin-settings.json"), "{}");
    writeFileSync(join(h.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('pacer-plugin.json','utf8'));
let n=0;await serve({manifest,input:stdinLines(),handlers:{'ui.render':async()=>{let document={type:'text',text:'valid'};if(++n%2===0)for(let i=0;i<300;i++)document={type:'stack',gap:'related',children:[document]};return {document,ttlS:-0}}}});`);
    await s.call("plugin.disable", { id: "fx-ui" }); await s.call("plugin.enable", { id: "fx-ui", grant: true });
    const params = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
    expect((await s.call("plugin.ui.render", params)).json.result.document.text).toBe("valid");
    await Bun.sleep(30);
    const refused = await s.call("plugin.ui.render", params);
    expect(refused.json.error).toMatchObject({ message: "This plugin's view couldn't be shown", data: { code: "invalid_input" } });
    // Still alive after the deep envelope.
    expect((await s.call("plugin.list", {})).json.result.plugins.length).toBeGreaterThan(0);
  } finally {
    const log = await s.stop(); h.done();
    expect(log).toContain("native plugin.list 512");
    expect(log).not.toContain("native plugin.list 513");
    // Native read attempted, then the original line replayed to TypeScript.
    expect(log).toContain("native plugin.settings.get 600");
  }
}, 90000);

test.skipIf(!front)("a busy surface answers conflict while later and forwarded lines answer first", async () => {
  for (const forward of ["", "plugin.settings.get"]) {
    const h = makeHome(), s = await stdio(h, forward);
    const started = join(h.home, "started"), release = join(h.home, "release");
    try {
      writeFileSync(join(h.plugin, "main.ts"), `#!/usr/bin/env bun
import {serve,stdinLines} from '@pacer/plugin';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./pacer-plugin.json',import.meta.url),'utf8'));
await serve({manifest,input:stdinLines(),handlers:{'ui.action':async p=>{
 if(p.action==='hold'){writeFileSync(${JSON.stringify(started)},'started');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(10);}
 return {result:'done'};
}}});`);
      await s.call("plugin.enable", { id: "fx-ui", grant: true });
      const action = { plugin: "fx-ui", surface: "activity", id: "checklist", context, action: "hold", requestId: "hold" };
      s.send(JSON.stringify({ jsonrpc: "2.0", id: 100, method: "plugin.ui.action", params: action }));
      for (let i = 0; i < 500 && !existsSync(started); i++) await Bun.sleep(10);
      expect(existsSync(started)).toBe(true);
      for (const [id, method, params] of [
        [101, "plugin.ui.action", action], [102, "plugin.list", {}], [103, "plugin.settings.get", { plugin: "fx-ui" }],
      ] as const) s.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      expect((await s.reply(101)).json.error.data.code).toBe("conflict");
      expect((await s.reply(102)).json.result.plugins.length).toBeGreaterThan(0);
      expect((await s.reply(103)).json.result.rev).toBe(0);
      expect(s.order).not.toContain("100");
      writeFileSync(release, "release");
      expect((await s.reply(100)).json.result).toEqual({ result: "done" });
      for (const id of ["101", "102", "103"]) expect(s.order.indexOf("100")).toBeGreaterThan(s.order.indexOf(id));
    } finally {
      writeFileSync(release, "release");
      const log = await s.stop(); h.done();
      if (forward) expect(log).not.toContain("native plugin.settings.get");
    }
  }
}, 90000);

test.skipIf(!front)("lone UTF-16 units survive the stdio wire, private IPC and settings store", async () => {
  const lines: Record<string, string[]> = {};
  const homes: Home[] = [];
  try {
    for (const [name, forward] of [["native", ""], ["forward", "*"], ["http", ""]] as const) {
      const h = makeHome(); homes.push(h);
      const manifest = JSON.parse(readFileSync(join(h.plugin, "pacer-plugin.json"), "utf8"));
      manifest.contributes.ui.settings[0].schema.fields.text = { type: "string", title: "Text" };
      writeFileSync(join(h.plugin, "pacer-plugin.json"), JSON.stringify(manifest));
      writeFileSync(join(h.plugin, "fixture.json"), JSON.stringify({ uiDocument: { type: "text", text: "a\ud800b\ufdd0" } }));
      const s = name === "http" ? await serve(h) : await stdio(h, forward);
      try {
        await s.call("plugin.enable", { id: "fx-ui", grant: true });
        const values = { text: "a\ud800b\ufdd0", items: ["\udfff", "\u{103ff}"] };
        const saved = await s.call("plugin.settings.set", { plugin: "fx-ui", values, expect_rev: 0 });
        expect(saved.json.result?.values).toEqual(values);
        expect(JSON.parse(readFileSync(join(h.state, "plugin-settings.json"), "utf8"))["fx-ui"].values).toEqual(values);
        const rendered = await s.call("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context });
        expect(rendered.json.result?.document).toEqual({ type: "text", text: "a\ud800b\ufdd0" });
        const got = await s.call("plugin.settings.get", { plugin: "fx-ui" });
        lines[name] = [saved.text, got.text, normalize(h, rendered.text), readFileSync(join(h.state, "plugin-settings.json"), "utf8")];
        if (name !== "http") {
          // A lone-surrogate request id is echoed byte for byte.
          const stdioSession = s as Awaited<ReturnType<typeof stdio>>;
          stdioSession.send('{"jsonrpc":"2.0","id":"\\ud800x","method":"plugin.settings.get","params":{"plugin":"fx-ui"}}');
          const echoed = await stdioSession.reply("\ud800x");
          expect(echoed.line.startsWith('{"jsonrpc":"2.0","id":"\\ud800x","result":')).toBe(true);
        }
      } finally { await s.stop(); }
    }
    expect(lines.native).toEqual(lines.forward);
    expect(lines.native).toEqual(lines.http);
  } finally { for (const h of homes) h.done(); }
}, 120000);

// A plugin child records whether it inherited the private key, and every start.
const recordingMain = `#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
appendFileSync('starts', process.pid + '\\n');
writeFileSync('inherited-key', process.env.PACER_NATIVE_CONFIG_SYNC_KEY ?? 'absent');
// @ts-ignore: installFixture copies the shared plugin.ts beside this entry point.
await import('./plugin');
`;
const starts = (h: Home) => existsSync(join(h.plugin, "starts")) ? readFileSync(join(h.plugin, "starts"), "utf8").trim().split("\n").map(Number) : [];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const save = (rev: number) => ({ plugin: "fx-ui", values: { required: true, items: ["a"] }, expect_rev: rev });
const heldLocks = (h: Home) => existsSync(join(h.state, "orca")) ? readdirSync(join(h.state, "orca")).filter(name => name.endsWith(".lock")) : [];
const connectionSockets = (h: Home) => existsSync(join(h.state, "run")) ? readdirSync(join(h.state, "run")).filter(name => /^s[0-9a-f]{12}\.sock$/.test(name)) : [];

test("the private plugin channel needs the sync key, hello v3 and no work grant", async () => {
  const request = { kind: "prepare", op: "plugin.list", params: {} };
  const sealed = (id: number, key: string, body: unknown = request) => ({ jsonrpc: "2.0", id, method: "_internal.plugins", params: { key, request: body } });
  const hello = (protocol: number) => ({ jsonrpc: "2.0", id: 0, method: "hello", params: { protocol } });
  // Lines are pushed one at a time so hello is answered before the sealed request is read.
  const session = async (env: Record<string, string>, key: string | undefined, before: unknown[], requests: unknown[]) => {
    const out: any[] = [];
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    async function* input() { for (;;) { while (queue.length) yield queue.shift()!; await new Promise<void>(r => wake = r); if (!queue.length) return; } }
    const done = runStdio(fakeCtx({ env }), input(), line => out.push(JSON.parse(line)), { nativeConfigKey: key });
    const push = (line: unknown) => { queue.push(JSON.stringify(line)); wake?.(); };
    for (const line of before) { push(line); for (let i = 0; i < 100 && !out.some(o => o.id === 0); i++) await Bun.sleep(10); }
    for (const line of requests) push(line);
    for (let i = 0; i < 200 && out.length < before.length + requests.length; i++) await Bun.sleep(10);
    wake?.(); await done;
    return out;
  };
  // [environment, door key, lines before, key sent]: each row breaks exactly one seal.
  for (const [env, key, before, sent] of [
    [{}, undefined, [hello(3)], "k"],
    [{}, "k", [hello(3)], "wrong"],
    [{ PACER_WORK_GRANT: "g" }, "k", [hello(3)], "k"],
    [{}, "k", [], "k"],
    [{}, "k", [hello(2)], "k"],
  ] as const) {
    const out = await session(env, key, [...before], [sealed(1, sent)]);
    expect(out.find(o => o.id === 1)).toMatchObject({ error: { code: -32601, data: { code: "unknown_op" } } });
  }
  const out = await session({}, "k", [hello(3)], [
    sealed(1, "k"),
    sealed(2, "k", { kind: "relay", id: "fx-ui", method: "diagnostic.ping", params: {} }),
  ]);
  expect(out.find(o => o.id === 1).result.entries).toBeArray();
  // Without the owner socket a relay would let Core spawn the child itself.
  expect(out.find(o => o.id === 2).result.error).toMatchObject({ code: "plugin_unavailable", message: "owner relay requires an attached stdio connection" });
  // The HTTP door never relays, even with the owner socket set and the plugin enabled.
  const h = makeHome();
  try {
    await callOp(fakeCtx({ home: h.home, pacerHome: h.state, env: { PATH: process.env.PATH! } }), "plugin.enable", { id: "fx-ui", grant: true });
    const ctx = fakeCtx({ home: h.home, pacerHome: h.state, env: { PATH: process.env.PATH!, PACER_HOST_SOCKET: join(h.state, "run", "host.sock") } });
    const http = await pluginNativeRequest(ctx, { kind: "relay", id: "fx-ui", method: "diagnostic.ping", params: {} });
    expect((http as any).error).toMatchObject({ code: "plugin_unavailable", message: "owner relay requires an attached stdio connection" });
  } finally { h.done(); }
});

test.skipIf(!front)("a client cannot reach the private channel and plugin children never inherit the key", async () => {
  for (const options of [tsOwner, ownerOn]) {
    const h = makeHome(), s = await stdio(h, "", options);
    try {
      writeFileSync(join(h.plugin, "main.ts"), recordingMain);
      const guessed = await s.call("_internal.plugins", { key: "0".repeat(64), request: { kind: "spawn_spec", id: "fx-ui" } });
      expect(guessed.json.error.data.code).toBe("unknown_op");
      await s.call("plugin.enable", { id: "fx-ui", grant: true });
      const doctor = await s.call("plugin.doctor", { id: "fx-ui" });
      expect(doctor.json.result.reports[0].ok, doctor.line).toBe(true);
      expect(readFileSync(join(h.plugin, "inherited-key"), "utf8")).toBe("absent");
    } finally { await s.stop(); h.done(); }
  }
}, 90000);

test.skipIf(!front)("a serve-less stdio connection owns its children on its own socket until it ends", async () => {
  const h = makeHome(), s = await stdio(h, "", ownerOn);
  let pid = 0;
  try {
    writeFileSync(join(h.plugin, "main.ts"), recordingMain);
    expect(existsSync(join(h.state, "run", "host.sock"))).toBe(false);
    expect(connectionSockets(h)).toHaveLength(1);
    expect(statSync(join(h.state, "run", connectionSockets(h)[0])).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.state, "run")).mode & 0o777).toBe(0o700);
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await s.call("plugin.ui.render", { plugin: "fx-ui", surface: "activity", id: "checklist", context })).json.error).toBeUndefined();
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect(starts(h)).toHaveLength(1);
    pid = starts(h)[0];
    expect(alive(pid)).toBe(true);
  } finally {
    const log = await s.stop();
    expect(log).toMatch(/^native plugin owner own .*\/run\/s[0-9a-f]{12}\.sock$/m);
    expect(connectionSockets(h)).toHaveLength(0);
    for (let i = 0; i < 300 && pid && alive(pid); i++) await Bun.sleep(10);
    expect(pid && alive(pid)).toBe(false);
    h.done();
  }
}, 60000);

test.skipIf(!front)("two serve-less stdio connections each own a lane (the accepted duplication)", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const a = await stdio(h, "", ownerOn), b = await stdio(h, "", ownerOn);
  try {
    expect(connectionSockets(h)).toHaveLength(2);
    await a.call("plugin.enable", { id: "fx-ui", grant: true });
    for (const s of [a, b]) expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect(starts(h)).toHaveLength(2);
    // Both owners still write settings through the one lock and revision.
    expect((await a.call("plugin.settings.set", save(0))).json.error).toBeUndefined();
    expect(semantic(await b.call("plugin.settings.set", save(0)))).toMatchObject({ code: "conflict" });
    expect((await b.call("plugin.settings.set", save(1))).json.error).toBeUndefined();
    expect((await a.call("plugin.settings.get", { plugin: "fx-ui" })).json.result.rev).toBe(2);
    // Every lock either owner took is released, and the store holds the last write.
    expect(heldLocks(h)).toEqual([]);
    expect(JSON.parse(readFileSync(join(h.state, "plugin-settings.json"), "utf8"))["fx-ui"]).toMatchObject({ rev: 2, values: save(1).values });
  } finally { await a.stop(); await b.stop(); expect(connectionSockets(h)).toHaveLength(0); h.done(); }
}, 60000);

test.skipIf(!front)("a flag-off stdio connection beside a flag-on serve keeps its own children and the settings revision", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const service = await serve(h, "", ownerOn);
  const s = await stdio(h, "", tsOwner);
  try {
    expect(connectionSockets(h)).toHaveLength(0);
    await service.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    // Flag-off, the stdio Core child owns its own child, as two TS cores always have.
    expect(starts(h)).toHaveLength(2);
    expect((await service.call("plugin.settings.set", save(0))).json.error).toBeUndefined();
    const stale = [await s.call("plugin.settings.set", save(0)), await service.call("plugin.settings.set", save(0))];
    expect(semantic(stale[0])).toEqual(semantic(stale[1]));
    expect(semantic(stale[0])).toMatchObject({ code: "conflict" });
    expect((await s.call("plugin.settings.set", save(1))).json.error).toBeUndefined();
    expect((await service.call("plugin.settings.get", { plugin: "fx-ui" })).json.result.rev).toBe(2);
  } finally {
    expect(await s.stop()).not.toMatch(/native plugin owner/);
    await service.stop(); h.done();
  }
}, 90000);

test.skipIf(!front)("a stdio connection attaches to the live serve owner and shares its children", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const service = await serve(h, "", ownerOn);
  const s = await stdio(h, "", ownerOn);
  try {
    expect(connectionSockets(h)).toHaveLength(0);
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    const params = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
    expect((await s.call("plugin.ui.render", params)).json.error).toBeUndefined();
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    // One child, started for the stdio connection, also serves the service.
    expect(starts(h)).toHaveLength(1);
    const [first] = starts(h);
    // Disable through stdio stops the shared lane; the service's next call starts a new one.
    expect((await s.call("plugin.disable", { id: "fx-ui" })).json.result).toBeDefined();
    for (let i = 0; i < 300 && alive(first); i++) await Bun.sleep(10);
    expect(alive(first)).toBe(false);
    expect((await service.call("plugin.enable", { id: "fx-ui", grant: true })).json.error).toBeUndefined();
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect(starts(h)).toHaveLength(2);
  } finally {
    const log = await s.stop();
    expect(log).toMatch(/^native plugin owner attach .*\/run\/host\.sock$/m);
    await service.stop(); h.done();
  }
}, 90000);

test.skipIf(!front)("a serve starts beside a stdio owner, both keep working, and later connections attach", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const owner = await stdio(h, "", ownerOn);
  let service: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    expect(connectionSockets(h)).toHaveLength(1);
    await owner.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await owner.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    service = await serve(h, "", ownerOn);
    expect(existsSync(join(h.state, "run", "host.sock"))).toBe(true);
    expect(connectionSockets(h)).toHaveLength(1);
    // The owning connection decided before serve started: it keeps its own child and answers.
    const params = { plugin: "fx-ui", surface: "activity", id: "checklist", context };
    expect((await owner.call("plugin.ui.render", params)).json.error).toBeUndefined();
    expect((await owner.call("plugin.settings.set", save(0))).json.error).toBeUndefined();
    expect((await service.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    expect((await service.call("plugin.settings.get", { plugin: "fx-ui" })).json.result.rev).toBe(1);
    expect(starts(h)).toHaveLength(2);
    const later = await stdio(h, "", ownerOn);
    const log = await later.stop();
    expect(log).toMatch(/^native plugin owner attach /m);
    expect((await owner.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
  } finally {
    await owner.stop();
    if (service) expect(await service.stop()).toContain("native plugin host enabled");
    h.done();
  }
}, 90000);

const params = { plugin: "fx-ui", surface: "activity", id: "checklist", context };

test.skipIf(!front)("flag-on stdio replies match flag-on HTTP, owning and attached", async () => {
  const flow = async (call: (op: string, params: unknown) => Promise<Reply>) => [
    await call("plugin.enable", { id: "fx-ui", grant: true }),
    await call("plugin.list", {}),
    await call("plugin.ui.render", params),
    await call("plugin.doctor", { id: "fx-ui" }),
    await call("plugin.settings.set", save(0)),
    await call("plugin.settings.set", save(0)),
    await call("plugin.settings.get", { plugin: "fx-ui" }),
  ];
  // An attached connection's Core learns the shared child's state on its first call (ADR 0027).
  const reads = async (call: (op: string, params: unknown) => Promise<Reply>) => [
    await call("plugin.doctor", { id: "fx-ui" }), await call("plugin.list", {}), await call("plugin.settings.get", { plugin: "fx-ui" }),
  ];
  // Serve's background usage refresh starts the bundled usage plugin; stdio has no such loop.
  const bytes = (h: Home, reply: Reply) => reply.json.result?.plugins
    ? normalize(h, JSON.stringify(reply.json.result.plugins.filter((p: any) => !p.bundled)))
    : reply.json.result !== undefined ? normalize(h, reply.text) : semantic(reply);
  const own = makeHome(), shared = makeHome();
  try {
    const s = await stdio(own, "", ownerOn);
    let owning: Reply[] = [];
    try { owning = await flow(s.call); } finally { await s.stop(); }
    const service = await serve(shared, "", ownerOn);
    let http: Reply[] = [], attached: Reply[] = [], again: Reply[] = [];
    try {
      http = await flow(service.call);
      const a = await stdio(shared, "", ownerOn);
      try { attached = await reads(a.call); } finally { expect(await a.stop()).toMatch(/^native plugin owner attach /m); }
      again = await reads(service.call);
    } finally { await service.stop(); }
    expect(owning.map(r => bytes(own, r))).toEqual(http.map(r => bytes(shared, r)));
    expect(attached.map(r => bytes(shared, r))).toEqual(again.map(r => bytes(shared, r)));
    // Core's snapshot does not know an owner-supervised child's pid, on either door.
    for (const doctor of [owning[3], http[3], attached[0]]) expect(doctor.json.result.reports[0].pid).toBeNull();
    expect(semantic(owning[5])).toMatchObject({ code: "conflict" });
  } finally { own.done(); shared.done(); }
}, 120000);

test.skipIf(!front)("a flag-off stdio connection ignores the owner socket a flag-on serve exported", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const service = await serve(h, "", ownerOn);
  // What a shell started under a flag-on serve inherits when it uses the escape hatch.
  const s = await stdio(h, "", { nativeHost: "0", hostSocket: join(h.state, "run", "host.sock") });
  try {
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await s.call("plugin.ui.render", params)).json.result.document).toBeDefined();
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].pid).toBe(starts(h)[0]);
    // The stdio core started its own TypeScript child; the service's owner started none.
    expect(starts(h)).toHaveLength(1);
  } finally {
    expect(await s.stop()).not.toMatch(/native plugin owner/);
    await service.stop(); h.done();
  }
}, 90000);

test.skipIf(!front)("an owning connection cleans up on SIGTERM, and a killed one's socket is swept later", async () => {
  const h = makeHome();
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  try {
    const a = await stdio(h, "", ownerOn);
    await a.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await a.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    const [pid] = starts(h);
    expect(connectionSockets(h)).toHaveLength(1);
    a.child.kill("SIGTERM");
    expect(await a.child.exited).toBe(143);
    await a.stop().catch(() => "");
    expect(connectionSockets(h)).toHaveLength(0);
    for (let i = 0; i < 300 && alive(pid); i++) await Bun.sleep(10);
    expect(alive(pid)).toBe(false);

    // SIGKILL leaves the socket behind. Once it is old enough to be nobody's bind
    // in progress, the next owning connection removes it before binding its own.
    const b = await stdio(h, "", ownerOn);
    const [stale] = connectionSockets(h);
    b.child.kill("SIGKILL"); await b.child.exited;
    await b.stop().catch(() => "");
    expect(connectionSockets(h)).toEqual([stale]);
    const fresh = await stdio(h, "", ownerOn);
    try { expect(connectionSockets(h)).toContain(stale); } finally { await fresh.stop(); }
    lutimesSync(join(h.state, "run", stale), 1_000_000_000, 1_000_000_000);
    const c = await stdio(h, "", ownerOn);
    try {
      expect(connectionSockets(h)).not.toContain(stale);
      expect(connectionSockets(h)).toHaveLength(1);
    } finally { await c.stop(); }
    expect(connectionSockets(h)).toHaveLength(0);
  } finally { h.done(); }
}, 90000);

/** The OS per-user private directory the door uses for deep homes. */
function privateBase(): string | undefined {
  if (process.platform !== "darwin") return process.env.XDG_RUNTIME_DIR;
  return Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim().replace(/\/+$/, "") || undefined;
}

/** `pacer-<64-bit FNV-1a of the canonical home>`, as the door names it. */
function privateDir(h: Home): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(realpathSync(h.state))) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return join(privateBase()!, `pacer-${hash.toString(16).padStart(16, "0")}`);
}

/** One line to a Unix socket, one line back. */
function ask(socket: string, message: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket, () => connection.write(`${JSON.stringify(message)}\n`));
    let text = "";
    connection.on("data", data => {
      text += data.toString("utf8");
      if (text.includes("\n")) { connection.end(); resolve(JSON.parse(text.slice(0, text.indexOf("\n")))); }
    });
    connection.on("error", reject);
  });
}

test.skipIf(!front || !privateBase())("a deep home's owning connection binds in the private per-user directory", async () => {
  const h = makeHome(true);
  writeFileSync(join(h.plugin, "main.ts"), recordingMain);
  const dir = privateDir(h);
  const s = await stdio(h, "", ownerOn);
  let socket = "";
  try {
    expect(join(h.state, "run", "s000000000000.sock").length).toBeGreaterThan(103);
    const sockets = readdirSync(dir).filter(name => /^s[0-9a-f]{12}\.sock$/.test(name));
    expect(sockets).toHaveLength(1);
    socket = join(dir, sockets[0]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(socket).mode & 0o777).toBe(0o600);
    await s.call("plugin.enable", { id: "fx-ui", grant: true });
    expect((await s.call("plugin.ui.render", params)).json.error).toBeUndefined();
    expect((await s.call("plugin.doctor", { id: "fx-ui" })).json.result.reports[0].ok).toBe(true);
    // The socket Core was given serves this connection's owner and its child.
    const found = await ask(socket, { jsonrpc: "2.0", id: 1, method: "_host.plugin.find", params: { id: "fx-ui" } });
    expect(found.result).toEqual({ found: true, id: "fx-ui", pid: starts(h)[0] });
  } finally {
    const log = await s.stop();
    expect(log).toContain(`native plugin owner own ${socket}`);
    expect(existsSync(socket)).toBe(false);
    expect(connectionSockets(h)).toHaveLength(0);
    rmdirSync(dir);
    h.done();
  }
}, 60000);

// (iv) OD-7 lands in PR 5: a second serve on a home whose host.sock owner is live exits with code 3.
test.todo("a second serve refuses to start while the home's owner socket is live (OD-7, PR 5)");
// (vi) A live socket served by another uid is never attached: `probe_home_owner_as` crate tests
// (crates/plugin-runtime/tests/owner_attach.rs), since an end-to-end check needs a second user.
