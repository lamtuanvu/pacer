import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { CoreError } from "../src/core/errors";
import { PlannerResources } from "../src/plugins/planner-resources";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

const manifest = manifestSchema.parse({
  id: "fx-native", version: "1.0.0", publisher: "pacer", host: "^1.6",
  contributes: { diagnostic: {} },
  capabilities: [{ name: "fs.read", scopes: ["${ACCOUNT_HOME}/**"] }, { name: "process.spawn", scopes: ["fx-tool", "fx-missing", "fx-elsewhere", "codex"] }, { name: "usage.state" }],
  reentrant: true, tier: "free",
});

// Answers hello and diagnostic.ping like a minimal plugin child.
const childScript = `const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:m.params.protocol,id:'fx-native',version:'1.0.0',contributes:['diagnostic']}});else if(m.method==='diagnostic.ping')send({id:m.id,result:{ok:true,uptimeS:0}});}}`;

const servers: Server[] = [];
const registries: PluginRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown();
  for (const server of servers.splice(0)) await new Promise(done => server.close(done));
});

function setup(socket: "fake" | "missing" | null) {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  mkdirSync(join(pacerHome, "run"), { recursive: true, mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n", { mode: 0o600 });
  const path = join(pacerHome, "run", "host.sock");
  const ctx: Ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH, ...(socket ? { PACER_HOST_SOCKET: path } : {}) } });
  const spawned: string[][] = [];
  const spawn = ((file: string, args: string[], options: object) => {
    spawned.push([file, ...args]);
    return nodeSpawn(file, args, options);
  }) as typeof nodeSpawn;
  const argv = [process.execPath, "-e", childScript];
  const registry = new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }], spawn,
    spawnBundled: () => ({ argv, cwd: home, env: {} }), eventPumpMs: 0 });
  registries.push(registry);
  return { ctx, registry, path, spawned, argv };
}

type Reply = (request: any, socket: Socket) => unknown;
async function fakeOwner(path: string, reply: Reply): Promise<{ requests: any[] }> {
  const requests: any[] = [];
  const server = createServer(socket => {
    let text = "";
    socket.on("data", data => {
      text += data.toString("utf8");
      const cut = text.indexOf("\n");
      if (cut < 0) return;
      const request = JSON.parse(text.slice(0, cut));
      requests.push(request);
      const body = reply(request, socket);
      if (body !== undefined) socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...body as object }) + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { requests };
}

// Forwards `next(answers)` to Core one at a time, then sends the final reply with `value`.
type Ask = { method: string; params: unknown } | undefined;
async function forwardingOwner(path: string, next: (answers: any[]) => Ask, value: unknown): Promise<{ answers: any[]; requests: any[] }> {
  const answers: any[] = [], requests: any[] = [];
  const server = createServer(socket => {
    let text = "", callId: unknown;
    const step = () => {
      const ask = next(answers);
      socket.write(JSON.stringify(ask ? { jsonrpc: "2.0", id: `core-${answers.length + 1}`, ...ask }
        : { jsonrpc: "2.0", id: callId, result: { value, hello: null, logs: [] } }) + "\n");
    };
    socket.on("data", data => {
      text += data.toString("utf8");
      for (let cut = text.indexOf("\n"); cut >= 0; cut = text.indexOf("\n")) {
        const frame = JSON.parse(text.slice(0, cut));
        text = text.slice(cut + 1);
        if (frame.method === "_host.plugin.call") { requests.push(frame); callId = frame.id; answers.length = 0; }
        else answers.push(frame.result ?? frame.error);
        step();
      }
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { answers, requests };
}

test("flag-on call goes to the native owner over host.sock with sealed spawn, authority and scope roots", async () => {
  const { ctx, registry, path, spawned, argv } = setup("fake");
  const note = join(ctx.home, "account", "note.txt");
  const owner = await fakeOwner(path, () => ({
    result: { value: { ok: true, uptimeS: 3 }, hello: { protocol: "1.10.0", served: ["diagnostic", "planner"] }, logs: ["from owner"] },
  }));
  const value = await registry.call(ctx, "fx-native", "diagnostic.ping", {}, {
    accountHome: join(ctx.home, "account"),
    resources: { reads: [{ path: note, kind: "file" }], commands: [], stores: [] },
  });
  expect(value).toEqual({ ok: true, uptimeS: 3 });
  expect(spawned).toEqual([]);
  expect(owner.requests).toHaveLength(1);
  const [request] = owner.requests;
  expect(request.method).toBe("_host.plugin.call");
  expect(request.params.id).toBe("fx-native");
  expect(request.params.method).toBe("diagnostic.ping");
  expect(request.params.params).toEqual({});
  expect(request.params.deadlineMs).toBeGreaterThan(0);
  expect(request.params.deadlineMs).toBeLessThanOrEqual(5000);
  expect(request.params.spawn.argv).toEqual(argv);
  expect(request.params.spawn.env.PACER_PLUGIN_ID).toBe("fx-native");
  expect(request.params.spawn.hello.manifest.id).toBe("fx-native");
  expect(request.params.spawn.hello.grants).toEqual(["fs.read", "process.spawn", "usage.state"]);
  expect(request.params.authority.resources.reads).toEqual([{ path: note, kind: "file" }]);
  expect(request.params.authority.grants).toEqual(["fs.read", "process.spawn", "usage.state"]);
  expect(request.params.processEnv).toBeUndefined();
  expect(request.params.authority.ttlMs).toBeLessThanOrEqual(5000);
  expect(request.params.scopeRoots).toEqual({ home: ctx.home, pacerHome: ctx.pacerHome, accountHome: join(ctx.home, "account") });
  // Owner hello marks readiness; points the manifest does not contribute are dropped.
  expect(registry.peek("fx-native")).toBe("ready");
  expect(registry.nativeSnapshot(ctx).find(entry => entry.id === "fx-native")?.served).toEqual(["diagnostic"]);
  expect(readFileSync(join(ctx.pacerHome, "logs", "plugins", "fx-native.log"), "utf8")).toContain("from owner");
});

test("flag-on pins bare command names to the resolved absolute executable and drops unresolved ones", async () => {
  const { ctx, registry, path } = setup("fake");
  ctx.which = name => ({ "fx-tool": "/opt/fx/bin/fx-tool", "fx-elsewhere": "/opt/fx/bin/other" } as Record<string, string>)[name] ?? null;
  const owner = await fakeOwner(path, () => ({ result: { value: { ok: true, uptimeS: 0 }, hello: null, logs: [] } }));
  await registry.call(ctx, "fx-native", "diagnostic.ping", {}, {
    resources: { reads: [], stores: [], commands: [
      { argv: ["fx-tool", "--json"], timeoutMs: 1000 },
      { argv: ["fx-missing"], timeoutMs: 1000 },
      { argv: ["fx-elsewhere"], timeoutMs: 1000 },
    ] },
  });
  expect(owner.requests[0].params.authority.resources.commands).toEqual([{ argv: ["/opt/fx/bin/fx-tool", "--json"], timeoutMs: 1000 }]);
});

test("flag-on seals a Codex live command for the call's account and the flag-off minimal environment", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  ctx.env = { ...ctx.env, HOME: ctx.home, LANG: "C", FX_SECRET: "leak" };
  ctx.which = name => ({ codex: "/opt/fx/bin/codex", "fx-tool": "/opt/fx/bin/fx-tool" } as Record<string, string>)[name] ?? null;
  const owner = await fakeOwner(path, () => ({ result: { value: { ok: true, uptimeS: 0 }, hello: null, logs: [] } }));
  const accountHome = join(ctx.home, "accounts", "team");
  const live = { argv: ["codex", "-s", "read-only", "-a", "never", "app-server"], timeoutMs: 10_000, mode: "codex-live" as const,
    env: { PATH: "/usr/bin", CODEX_HOME: accountHome } };
  const resources = (commands: object[]) => ({ reads: [{ path: join(accountHome, "sessions"), kind: "codex-logs" as const }], stores: [], commands } as never);
  await registry.call(ctx, "fx-native", "diagnostic.ping", {}, { accountHome, resources: resources([live, { argv: ["fx-tool"], timeoutMs: 1000 }]) });
  const sealed = owner.requests[0].params;
  expect(sealed.authority.resources.commands).toEqual([
    { ...live, argv: ["/opt/fx/bin/codex", ...live.argv.slice(1)] },
    { argv: ["/opt/fx/bin/fx-tool"], timeoutMs: 1000 },
  ]);
  expect(sealed.authority.resources.reads).toEqual([{ path: join(accountHome, "sessions"), kind: "codex-logs" }]);
  expect(sealed.processEnv).toEqual({ PATH: process.env.PATH, HOME: ctx.home, LANG: "C" });
  expect(sealed.coreMethods).toEqual(["capability.fs.read", "capability.fs.list", "capability.fs.stat", "capability.fs.readRange"]);
  // The same admission prepareSpawnAuthority applies flag-off, before dialing.
  for (const [commands, accountHomeOption] of [
    [[{ ...live, env: { CODEX_HOME: join(ctx.home, "other") } }], accountHome],
    [[live], undefined],
    [[{ ...live, cwd: ctx.home }], accountHome],
    [[{ ...live, timeoutMs: 20_000 }], accountHome],
    [[{ ...live, argv: [...live.argv, "--extra"] }], accountHome],
    [[{ argv: ["fx-tool"], timeoutMs: 1000, mode: "session-duplex" }], accountHome],
  ] as const) {
    await expect(registry.call(ctx, "fx-native", "diagnostic.ping", {}, { accountHome: accountHomeOption, resources: resources([...commands]) }))
      .rejects.toMatchObject({ code: "capability_denied" });
  }
  expect(owner.requests).toHaveLength(1);
  expect(spawned).toEqual([]);
});

test("flag-on answers owner-forwarded usage state with the flag-off broker and only for issued stores", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const store = join(ctx.pacerHome, "cache", "arkcli-usage-plan.json");
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true, mode: 0o700 });
  const before = JSON.stringify({ capturedAt: 1, value: { plan: "pro" } });
  writeFileSync(store, before, { mode: 0o600 });
  const fresh = Buffer.from(JSON.stringify({ capturedAt: 2, value: { plan: "max" } })).toString("base64");
  const { answers, requests } = await forwardingOwner(path, answers => [
    { method: "capability.usage.state.begin", params: { store: "arkcli-usage-plan" } },
    { method: "capability.usage.state.readChunk", params: { lease: answers[0]?.lease, offset: 0, length: answers[0]?.bytes } },
    { method: "capability.usage.state.stageChunk", params: { lease: answers[0]?.lease, offset: 0, base64: fresh } },
    { method: "capability.usage.state.commit", params: { lease: answers[0]?.lease } },
    { method: "capability.usage.state.begin", params: { store: "arkcli-usage-plan" } },
    { method: "capability.usage.state.release", params: { lease: answers[4]?.lease } },
    { method: "capability.usage.state.begin", params: { store: "codex-cursors" } },
    { method: "capability.fs.read", params: { path: store } },
  ][answers.length], { ok: true, uptimeS: 0 });
  await registry.call(ctx, "fx-native", "diagnostic.ping", {}, {
    resources: { reads: [], commands: [], stores: [{ id: "arkcli-usage-plan", path: store, kind: "cache" }] },
  });
  expect(requests[0].params.coreMethods).toEqual(["capability.usage.state.begin", "capability.usage.state.readChunk",
    "capability.usage.state.stageChunk", "capability.usage.state.commit", "capability.usage.state.release"]);
  expect(answers[0]).toMatchObject({ lease: expect.any(String), bytes: Buffer.byteLength(before) });
  expect(Buffer.from(answers[1].base64, "base64").toString("utf8")).toBe(before);
  expect(answers[2]).toEqual({ bytes: Buffer.from(fresh, "base64").length });
  expect(answers[3]).toEqual({ saved: true });
  expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({ capturedAt: 2, value: { plan: "max" } });
  expect(answers[4]).toMatchObject({ bytes: readFileSync(store).length });
  expect(answers[5]).toEqual({ ok: true });
  expect(answers[6]).toMatchObject({ code: -32000, data: { code: "capability_denied" }, message: "usage state store is not authorized" });
  expect(answers[7]).toMatchObject({ code: -32000, data: { code: "capability_denied" } });
  expect(spawned).toEqual([]);
});

test("flag-on answers owner-forwarded Codex log reads with the flag-off filesystem broker", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const accountHome = join(ctx.home, "accounts", "team");
  const sessions = join(accountHome, "sessions");
  const log = join(sessions, "2026", "11", "07", "rollout-1.jsonl");
  mkdirSync(join(sessions, "2026", "11", "07"), { recursive: true });
  writeFileSync(log, "{\"type\":\"token_count\"}\n");
  writeFileSync(join(accountHome, "auth.json"), "{}\n");
  const { answers, requests } = await forwardingOwner(path, answers => [
    { method: "capability.fs.list", params: { dir: sessions, glob: "**/*.jsonl" } },
    { method: "capability.fs.read", params: { path: log } },
    { method: "capability.fs.read", params: { path: join(accountHome, "auth.json") } },
  ][answers.length], { ok: true, uptimeS: 0 });
  await registry.call(ctx, "fx-native", "diagnostic.ping", {}, { accountHome, resources: { reads: [{ path: sessions, kind: "codex-logs" }], commands: [], stores: [] } });
  expect(requests[0].params.authority.resources.reads).toEqual([{ path: sessions, kind: "codex-logs" }]);
  expect(answers[0]).toMatchObject({ files: [{ path: log }], complete: true });
  expect(answers[1]).toMatchObject({ text: "{\"type\":\"token_count\"}\n" });
  expect(answers[2]).toMatchObject({ data: { code: "capability_denied" } });
  expect(spawned).toEqual([]);
});

test("flag-on serves read-only planner borrows with Core-answered reads and refuses effect borrows", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const folder = join(ctx.home, ".claude");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "settings.json"), "{\"theme\":\"dark\"}\n");
  writeFileSync(join(ctx.home, "outside.txt"), "private\n");
  const input = { agent: "claude-code", home: ctx.home, pacerHome: ctx.pacerHome, binary: null,
    env: { now: ctx.now, pacerArgv: ["pacer"], plannerKey: "claude-code", folder }, prior: { planner: "claude-code", files: [] } };
  const lease = (purpose: "preview" | "install") => new PlannerResources(ctx, { purpose, cwd: ctx.home, binaries: [], roots: [folder] });
  const { answers, requests } = await forwardingOwner(path, answers => [
    { method: "capability.fs.read", params: { path: join(folder, "settings.json") } },
    { method: "capability.fs.read", params: { path: join(ctx.home, "outside.txt") } },
    { method: "capability.usage.state.begin", params: { store: "codex-cursors" } },
  ][answers.length], { schema: 1 });
  const preview = lease("preview");
  expect(await registry.call(ctx, "fx-native", "planner.plan", input, { plannerResources: preview, accountHome: folder })).toEqual({ schema: 1 });
  await preview.dispose();
  expect(requests[0].params.coreMethods).toEqual(["capability.fs.read", "capability.fs.list", "capability.fs.stat", "capability.fs.readRange"]);
  expect(requests[0].params.params).toEqual(input);
  expect(answers[0]).toMatchObject({ text: "{\"theme\":\"dark\"}\n" });
  expect(answers[1]).toMatchObject({ data: { code: "capability_denied" }, message: "planner source outside selected root or declared scope" });
  expect(answers[2]).toMatchObject({ data: { code: "capability_denied" } });
  // An install borrow, an effect method, or a prior too large for one frame never reaches the owner.
  const install = lease("install");
  await expect(registry.call(ctx, "fx-native", "planner.plan", input, { plannerResources: install, accountHome: folder }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  await expect(registry.call(ctx, "fx-native", "planner.install", input, { plannerResources: install, accountHome: folder }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  await install.dispose();
  const large = lease("preview");
  await expect(registry.call(ctx, "fx-native", "planner.plan", { ...input, prior: { planner: "claude-code", note: "x".repeat(1024 * 1024) } },
    { plannerResources: large, accountHome: folder })).rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining("prior planner record") });
  await large.dispose();
  expect(requests).toHaveLength(1);
  expect(spawned).toEqual([]);
});

test("flag-on bridge errors keep their CoreError codes", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  let next: unknown = { error: { code: -32002, message: "handshake failed", data: { code: "plugin_refused" } } };
  await fakeOwner(path, () => next);
  const call = () => registry.call(ctx, "fx-native", "diagnostic.ping", {});
  await expect(call()).rejects.toMatchObject({ code: "plugin_refused", message: "handshake failed" });
  next = { error: { code: -32002, message: "unknown tracked plugin: fx-native" } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: "unknown tracked plugin: fx-native" });
  next = { result: { activated: false, reason: "native-plugin-ownership-not-activated" } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining(path) });
  next = { error: { code: -32002, message: "bad input", data: { code: "invalid_input", hint: "fix it" } } };
  await expect(call()).rejects.toMatchObject({ code: "invalid_input", message: "bad input", hint: "fix it" });
  next = { error: { code: -32002, message: "slow down", data: { code: "rate_limited" } } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: "slow down" });
  next = { error: { code: -32602, message: "invalid spawn argv" } };
  await expect(call()).rejects.toMatchObject({ code: "invalid_input" });
  next = { error: { code: -32601, message: "Method not found" } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining("does not serve") });
  next = { error: { code: -32001, message: "unauthorized" } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining("refused this caller") });
  next = { result: { value: 1 } };
  await expect(call()).rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining("malformed") });
  expect(spawned).toEqual([]);
});

test("flag-on caller abort hangs up the bridge call", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  let closed!: () => void;
  const hungUp = new Promise<void>(done => { closed = done; });
  await fakeOwner(path, (_request, socket) => { socket.on("close", closed); return undefined; });
  const controller = new AbortController();
  const call = registry.call(ctx, "fx-native", "diagnostic.ping", {}, { signal: controller.signal });
  await new Promise(done => setTimeout(done, 100));
  controller.abort();
  await expect(call).rejects.toMatchObject({ code: "plugin_unavailable", message: "owning plugin call ended" });
  await hungUp;
  expect(spawned).toEqual([]);
});

test("flag-on refuses orca and hosts resources and oversized frames without dialing", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const owner = await fakeOwner(path, () => ({ result: { value: { ok: true, uptimeS: 0 }, hello: null, logs: [] } }));
  const host = { alias: "box", hostFingerprint: "fp", script: "probe", args: [], timeoutMs: 1000, maxBytes: 10 };
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", {}, { resources: { reads: [], commands: [], stores: [], hosts: [host] } }))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: expect.stringContaining("orca or hosts") });
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", { blob: "x".repeat(1024 * 1024) }))
    .rejects.toMatchObject({ code: "too_large" });
  expect(owner.requests).toEqual([]);
  expect(spawned).toEqual([]);
});

test("flag-on with a missing socket is plugin_unavailable naming the socket and never spawns", async () => {
  const { ctx, registry, path, spawned } = setup("missing");
  expect(existsSync(path)).toBe(false);
  const failure = await registry.call(ctx, "fx-native", "diagnostic.ping", {}).then(() => null, (error: CoreError) => error);
  expect(failure).toBeInstanceOf(CoreError);
  expect(failure?.code).toBe("plugin_unavailable");
  expect(failure?.message).toContain(path);
  expect(failure?.message).not.toContain("supervises plugin children");
  const [report] = await registry.doctor(ctx, "fx-native");
  expect(report?.ok).toBe(false);
  expect(report?.error).toContain(`plugin_unavailable: native process owner socket ${path}`);
  expect(spawned).toEqual([]);
});

test("flag-on refuses host-only call options without spawning or dialing", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const owner = await fakeOwner(path, () => ({ result: { value: { ok: true, uptimeS: 0 }, hello: null, logs: [] } }));
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", {}, { onProgress: () => {} }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(owner.requests).toEqual([]);
  expect(spawned).toEqual([]);
});

test("flag-off keeps the local child and never dials the bridge", async () => {
  const { ctx, registry, path, spawned, argv } = setup(null);
  const owner = await fakeOwner(path, () => ({ error: { code: -32002, message: "must not be called" } }));
  const value = await registry.call(ctx, "fx-native", "diagnostic.ping", {});
  expect(value).toEqual({ ok: true, uptimeS: 0 });
  expect(spawned).toEqual([argv]);
  expect(owner.requests).toEqual([]);
  expect(registry.peek("fx-native")).toBe("ready");
});
