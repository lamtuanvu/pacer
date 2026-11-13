import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostClient } from "../packages/plugin-sdk/src";
import { BUNDLED } from "../plugins/bundled";
import { discoverEndpointModels, endpointLaunchSettings } from "../src/plugins/endpoint-adapter";
import { relayOwner, type Relay } from "./fixtures/native-owner-relay";
import { authed, ownerKey } from "./fixtures/owner-auth";
import { preparePlannerInstall } from "../packages/plugin-sdk/src/install/prepared";
import { createPlannerIO, readPlannerPrior } from "../packages/plugin-sdk/src/install/transport";
import { preparePlannerUninstallFiles } from "../packages/plugin-sdk/src/install/uninstall";
import { CoreError } from "../src/core/errors";
import { validateClassifier } from "../src/config/classifier";
import { agentConnect } from "../src/core/setup";
import { withPlannerInstall } from "../src/plugins/planner-install";
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

// Core in this process holds the owner credential the stand-in owners check.
ownerKey();

const servers: Server[] = [];
const registries: PluginRegistry[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.shutdown();
  for (const server of servers.splice(0)) await new Promise(done => server.close(done));
  for (const relay of relays.splice(0)) await relay.close();
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
  const server = createServer(authed(socket => {
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
  }));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { requests };
}

// Forwards `next(answers)` to Core one at a time, then sends the final reply with `value`.
type Ask = { method: string; params: unknown } | undefined;
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for owner");
    await Bun.sleep(5);
  }
}

async function forwardingOwner(path: string, next: (answers: any[]) => Ask, value: unknown, stopOnChunkError = false): Promise<{ answers: any[]; requests: any[]; closed: () => boolean }> {
  const answers: any[] = [], requests: any[] = [];
  let closed = false;
  const server = createServer(authed(socket => {
    socket.once("close", () => { closed = true; });
    // Core closes on a failed chunk; a fallback write may race that close.
    socket.on("error", () => {});
    let text = "", callId: unknown;
    let chunkPending = false;
    const step = () => {
      const ask = next(answers);
      if (ask?.method === "$/resultChunk" && (ask.params as { request?: unknown }).request === 1) ask.params = { ...(ask.params as object), request: callId };
      chunkPending = ask?.method === "$/resultChunk";
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
        if (!stopOnChunkError || !frame.error || !chunkPending) step();
      }
    });
  }));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { answers, requests, closed: () => closed };
}

test("flag-on call goes to the native owner over host.sock with sealed spawn, authority and scope roots", async () => {
  const { ctx, registry, path, spawned, argv } = setup("fake");
  const note = join(ctx.home, "account", "note.txt");
  const owner = await fakeOwner(path, () => ({
    result: { value: { ok: true, uptimeS: 3 }, hello: { protocol: "1.10.0", served: ["diagnostic", "planner"] }, logs: [{ level: "warn", message: "from owner" }, "older owner line"] },
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
  // Call-scoped capability.log lines keep their level, as the TypeScript host writes them.
  const log = readFileSync(join(ctx.pacerHome, "logs", "plugins", "fx-native.log"), "utf8");
  expect(log).toContain("[warn] from owner");
  expect(log).toContain("[stderr] older owner line");
});

test("a plugin's own error relayed by the owner is the plugin's failure, while owner failures stay pacer's", async () => {
  const { PluginReportedError, raisedByPacer } = await import("../src/core/errors");
  const { ctx, registry, path } = setup("fake");
  let origin: string | undefined = "plugin";
  await fakeOwner(path, () => ({ error: { code: -32002, message: "reader failed", data: { code: "plugin_unavailable", ...(origin ? { origin } : {}) } } }));
  const relayed = await registry.call(ctx, "fx-native", "diagnostic.ping", {}).catch((error: unknown) => error);
  expect(relayed).toBeInstanceOf(PluginReportedError);
  expect(raisedByPacer(relayed)).toBe(false);
  origin = undefined;
  const owned = await registry.call(ctx, "fx-native", "diagnostic.ping", {}).catch((error: unknown) => error);
  expect(owned).toBeInstanceOf(CoreError);
  expect(owned).not.toBeInstanceOf(PluginReportedError);
  expect(raisedByPacer(owned)).toBe(true);
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
  expect(sealed.coreMethods).toEqual(["capability.fs.read", "capability.fs.list", "capability.fs.stat", "capability.fs.readRange", "capability.identity.sign"]);
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
    "capability.usage.state.stageChunk", "capability.usage.state.commit", "capability.usage.state.release", "capability.identity.sign"]);
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
  expect(requests[0].params.coreMethods).toEqual(["capability.fs.read", "capability.fs.list", "capability.fs.stat", "capability.fs.readRange", "capability.identity.sign"]);
  expect(requests[0].params.params).toEqual(input);
  expect(answers[0]).toMatchObject({ text: "{\"theme\":\"dark\"}\n" });
  expect(answers[1]).toMatchObject({ data: { code: "capability_denied" }, message: "planner source outside selected root or declared scope" });
  expect(answers[2]).toMatchObject({ data: { code: "capability_denied" } });
  expect(requests[0].params.requireFeatures).toBeUndefined();
  // An install borrow on a read-only method never reaches the owner.
  const install = lease("install");
  await expect(registry.call(ctx, "fx-native", "planner.plan", input, { plannerResources: install, accountHome: folder }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  await install.dispose();
  expect(requests).toHaveLength(1);
  // A prior too large for one frame goes by handle; the child must have negotiated planner transactions to read it.
  const large = lease("preview");
  await registry.call(ctx, "fx-native", "planner.plan", { ...input, prior: { planner: "claude-code", note: "x".repeat(1024 * 1024) } },
    { plannerResources: large, accountHome: folder });
  await large.dispose();
  expect(requests).toHaveLength(2);
  expect(requests[1].params.params.prior).toBeUndefined();
  expect(requests[1].params.params.priorRange).toMatchObject({ handle: expect.any(String), bytes: expect.any(Number) });
  expect(requests[1].params.requireFeatures).toEqual(["plannerInstallTransactions"]);
  expect(requests[1].params.coreMethods).toContain("capability.planner.readPriorRange");
  expect(requests[1].params.coreMethods).not.toContain("capability.planner.run");
  expect(spawned).toEqual([]);
});

const plannerManifest = (folder: string) => manifestSchema.parse({
  id: "fx-planner", version: "1.0.0", publisher: "pacer", host: "^1.6",
  contributes: { planner: {} },
  capabilities: [{ name: "fs.read", scopes: [folder + "/**"] }, { name: "fs.write", scopes: [folder + "/**"] }, { name: "process.spawn", scopes: ["fx-planner"] }],
  reentrant: false, tier: "free",
});

/** A planner command that appends its direction to `<target>.log`. */
function plannerSetup() {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  const folder = join(home, "planner");
  mkdirSync(join(pacerHome, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "settings.json"), "before", { mode: 0o600 });
  const tool = join(home, "bin", "fx-planner");
  mkdirSync(join(home, "bin"));
  writeFileSync(tool, "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$1.log\"\n", { mode: 0o755 });
  const path = join(pacerHome, "run", "host.sock");
  const ctx: Ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH, PACER_HOST_SOCKET: path } });
  ctx.which = name => name === "fx-planner" ? tool : null;
  const spawned: string[][] = [];
  const spawn = ((file: string, args: string[], options: object) => {
    spawned.push([file, ...args]);
    return nodeSpawn(file, args, options);
  }) as typeof nodeSpawn;
  const registry = new PluginRegistry({ bundled: [{ manifest: plannerManifest(folder), main: async () => ({ handlers: {} }) }], spawn,
    spawnBundled: () => ({ argv: [process.execPath, "-e", childScript], cwd: home, env: {} }), eventPumpMs: 0 });
  registries.push(registry);
  const options = { pluginId: "fx-planner", roots: [folder], binaries: ["fx-planner"], registry, commandApproval: () => true };
  return { ctx, folder, path, spawned, options, log: join(folder, "command.log") };
}

type PlannerHandler = (params: any, host: HostClient) => Promise<unknown>;
/**
 * Stands in for the Rust owner and the planner child: runs the SDK planner code, sends
 * each capability request back to Core on the call's connection, then sends the final reply.
 * Mirrors the real owner's `requireFeatures` gate (`bridge_call.rs`): a request whose
 * `requireFeatures` is not a subset of `negotiated` is refused before the handler runs and
 * nothing is forwarded, so a test can model a child that did not negotiate a feature.
 */
async function plannerOwner(path: string, handlers: Record<string, PlannerHandler>,
  negotiated: string[] = ["plannerInstallTransactions"]): Promise<{ requests: any[]; forwarded: any[] }> {
  const requests: any[] = [], forwarded: any[] = [];
  const server = createServer(authed(socket => {
    let text = "", next = 1;
    const waiting = new Map<string, (frame: any) => void>();
    const host = { call: (method: string, params?: unknown) => new Promise((resolve, reject) => {
      const id = `core-${next++}`;
      waiting.set(id, frame => {
        forwarded.push({ method, params, reply: frame.result ?? frame.error });
        if (frame.error) reject(Object.assign(new Error(frame.error.message), { code: frame.error.data?.code }));
        else resolve(frame.result);
      });
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    }) } as unknown as HostClient;
    const reply = (id: unknown, body: object) => socket.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
    socket.on("data", data => {
      text += data.toString("utf8");
      for (let cut = text.indexOf("\n"); cut >= 0; cut = text.indexOf("\n")) {
        const frame = JSON.parse(text.slice(0, cut));
        text = text.slice(cut + 1);
        if (frame.method !== "_host.plugin.call") {
          for (const [id, settle] of waiting) {
            if (id !== frame.id) continue;
            waiting.delete(id);
            settle(frame);
          }
          continue;
        }
        requests.push(frame);
        const required: string[] = frame.params.requireFeatures ?? [];
        const missing = required.find(feature => !negotiated.includes(feature));
        if (missing !== undefined) {
          reply(frame.id, { error: { code: -32002, message: `${frame.params.method as string} requires the negotiated ${missing} feature`, data: { code: "capability_denied" } } });
          continue;
        }
        const method = String(frame.params.method);
        const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
        if (!handler) {
          reply(frame.id, { error: { code: -32601, message: `unknown method ${method}`, data: { code: "plugin_unavailable" } } });
          continue;
        }
        handler(frame.params.params, host).then(
          value => reply(frame.id, { result: { value, hello: { protocol: "1.10.0", served: ["diagnostic", "planner"], features: negotiated }, logs: [] } }),
          (error: Error) => reply(frame.id, { error: { code: -32002, message: error.message, data: { code: "plugin_unavailable" } } }));
      }
    });
  }));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  return { requests, forwarded };
}

const prior = async (params: any, host: HostClient) => params.priorRange ? await readPlannerPrior(host, params.priorRange) as any : params.prior;
const installHandler = (fail = false): PlannerHandler => async (params, host) => preparePlannerInstall(createPlannerIO(host), params.env, await prior(params, host), async tx => {
  await tx.run([params.binary, params.env.folder + "/command", "forward"], [params.binary, params.env.folder + "/command", "undo"]);
  if (fail) throw new Error("planner child exited during installation");
  await tx.edit(params.env.folder + "/settings.json", () => "installed", []);
});
const uninstallHandler: PlannerHandler = async (params, host) => preparePlannerUninstallFiles(createPlannerIO(host), await prior(params, host));

test("flag-on planner.install runs over the bridge as a Core transaction with pinned commands, journal and backups", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const owner = await plannerOwner(path, { "planner.install": installHandler() });
  const report = await withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  const [request] = owner.requests;
  expect(request.params.method).toBe("planner.install");
  expect(request.params.requireFeatures).toEqual(["plannerInstallTransactions"]);
  expect(request.params.coreMethods).toEqual(["capability.fs.read", "capability.fs.list", "capability.fs.stat", "capability.fs.readRange",
    "capability.planner.run", "capability.process.outputChunk", "$/resultChunk", "capability.identity.sign", "capability.planner.readPriorRange"]);
  // Core seals no commands to the owner: it pins and runs them itself so it keeps the undo work.
  expect(request.params.authority.resources.commands).toEqual([]);
  expect(owner.forwarded.map(entry => entry.method)).toEqual(["capability.planner.run", "capability.fs.read", "capability.fs.read"]);
  expect(owner.forwarded[0].reply).toMatchObject({ code: 0 });
  expect(readFileSync(log, "utf8")).toBe("forward\n");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("installed");
  const backup = report.record.files[0]!.backup!;
  expect(readFileSync(backup, "utf8")).toBe("before");
  const saved = JSON.parse(readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8"));
  expect(saved.planners.synthetic).toEqual(report.record);
  expect(saved.planners.synthetic.commands).toEqual([{ undo: [ctx.which("fx-planner"), folder + "/command", "undo"] }]);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on planner.uninstall over the bridge restores the backup and drops the record", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const owner = await plannerOwner(path, { "planner.install": installHandler(), "planner.uninstall": uninstallHandler });
  await withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  await withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", { ...options, operation: "uninstall" });
  const request = owner.requests[1];
  expect(request.params.method).toBe("planner.uninstall");
  expect(request.params.requireFeatures).toEqual(["plannerInstallTransactions"]);
  expect(request.params.params.prior.planner).toBe("synthetic");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  const saved = JSON.parse(readFileSync(join(ctx.pacerHome, "install-manifest.json"), "utf8"));
  expect(saved.planners.synthetic).toBeUndefined();
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on failed planner.install compensates its admitted commands and leaves files untouched", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const owner = await plannerOwner(path, { "planner.install": installHandler(true) });
  await expect(withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: "planner child exited during installation" });
  expect(owner.forwarded.map(entry => entry.method)).toEqual(["capability.planner.run"]);
  // Core ran the undo it pinned before the forward command.
  expect(readFileSync(log, "utf8")).toBe("forward\nundo\n");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on refuses an out-of-selection planner command inside the transaction, and a consent-less connect never dials", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const owner = await plannerOwner(path, {
    "planner.install": async (params, host) => {
      await host.call("capability.planner.run", { argv: ["/bin/sh", "-c", "true"], timeoutMs: 1000 }).catch(() => undefined);
      return installHandler()(params, host);
    },
  });
  await withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  expect(owner.forwarded[0]).toMatchObject({ method: "capability.planner.run",
    reply: { data: { code: "capability_denied" }, message: "planner executable is outside host selection" } });
  const requests = owner.requests.length;
  await expect(agentConnect(ctx, "claude-code", {})).rejects.toMatchObject({ code: "not_allowed", message: "connecting an agent requires consent" });
  expect(owner.requests).toHaveLength(requests);
  expect(spawned).toEqual([]);
});

test("flag-on install over the bridge is cancelled and compensates when the plugin is disabled mid-call", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  // `disable` needs an existing strategy file to edit (plannerSetup does not write one).
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n", { mode: 0o600 });
  // A slow pinned command writes its direction immediately then sleeps, so the forward
  // marker lands before the mid-call revoke and the call is still in flight when it is
  // disabled; the undo must run after the revoke, with the same ordering as a bridge failure.
  writeFileSync(join(ctx.home, "bin", "fx-planner"), "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$1.log\"\nsleep 0.3\n", { mode: 0o755 });
  await plannerOwner(path, { "planner.install": installHandler() });
  const promise = withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  await new Promise(done => setTimeout(done, 100));
  // Disabling the plugin revokes its authorities, same as flag-off; the registered
  // native-owner authority must be among them so the in-flight call is cancelled too.
  await options.registry.disable(ctx, "fx-planner");
  await expect(promise).rejects.toMatchObject({ code: "plugin_unavailable", message: "owning plugin call ended" });
  // The pinned undo ran in reverse of the forward (the forward is killed mid-flight,
  // so only the undo's marker is present; the point is that rollback executed it).
  expect(readFileSync(log, "utf8")).toContain("undo");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on install over the bridge is cancelled when the planner configuration generation changes mid-call", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  writeFileSync(join(ctx.home, "bin", "fx-planner"), "#!/bin/sh\nprintf '%s\\n' \"$2\" >> \"$1.log\"\nsleep 0.3\n", { mode: 0o755 });
  await plannerOwner(path, { "planner.install": installHandler() });
  const promise = withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  await new Promise(done => setTimeout(done, 100));
  // Change the plugin's `plugins.config.<id>` slice in the strategy file directly: this is
  // what moves `e.plannerFingerprint`, the same generation `options.registry.refresh` checks
  // flag-off before admission. The native-owner path must check it too, mid-call.
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    fx-planner:\n      note: changed\n");
  options.registry.refresh(ctx);
  await expect(promise).rejects.toMatchObject({ code: "plugin_unavailable", message: "owning plugin call ended" });
  // The pinned undo ran in reverse of the forward (the forward is killed mid-flight,
  // so only the undo's marker is present; the point is that rollback executed it).
  expect(readFileSync(log, "utf8")).toContain("undo");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on install over the bridge compensates when the owner drops the socket after a forwarded command", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const server = createServer(authed(socket => {
    socket.once("data", data => {
      const frame = JSON.parse(data.toString("utf8").split("\n")[0]!);
      const params = frame.params.params;
      socket.write(JSON.stringify({
        jsonrpc: "2.0", id: "core-1", method: "capability.planner.run",
        params: { argv: [params.binary, params.env.folder + "/command", "forward"], undo: [params.binary, params.env.folder + "/command", "undo"], timeoutMs: 1000 },
      }) + "\n");
      // The owner drops the connection instead of relaying the child's next request
      // or the final reply: Core must compensate the command it already admitted.
      socket.once("data", () => socket.destroy());
    });
  }));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  await expect(withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(readFileSync(log, "utf8")).toBe("forward\nundo\n");
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on refuses a planner call the owner stub has not negotiated the feature for, forwarding nothing", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const owner = await plannerOwner(path, { "planner.install": installHandler() }, []);
  await expect(withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options))
    .rejects.toMatchObject({ code: "capability_denied", message: expect.stringContaining("plannerInstallTransactions") });
  expect(owner.forwarded).toEqual([]);
  expect(existsSync(log)).toBe(false);
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
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

test("flag-on refuses hosts resources and oversized frames without dialing", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const owner = await fakeOwner(path, () => ({ result: { value: { ok: true, uptimeS: 0 }, hello: null, logs: [] } }));
  const host = { alias: "box", hostFingerprint: "fp", script: "probe", args: [], timeoutMs: 1000, maxBytes: 10 };
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", {}, { resources: { reads: [], commands: [], stores: [], hosts: [host] } }))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: "diagnostic.ping needs hosts resources, which the native process owner bridge does not serve" });
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", { blob: "x".repeat(1024 * 1024) }))
    .rejects.toMatchObject({ code: "too_large" });
  expect(owner.requests).toEqual([]);
  expect(spawned).toEqual([]);
});

const endpoints = BUNDLED.find(plugin => plugin.manifest.id === "pacer-endpoints")!;
const endpointScript = join(import.meta.dir, "..", "plugins", "pacer-endpoints", "index.ts");
// Answers hello and endpoint.launchEnv with `reply`, its @HOME@ replaced by the call's pacerHome.
const launchScript = (reply: unknown) => `const reply=${JSON.stringify(JSON.stringify(reply))};const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:m.params.protocol,id:'pacer-endpoints',version:m.params.manifest.version,contributes:['endpoint']}});else if(m.method==='endpoint.launchEnv')send({id:m.id,result:JSON.parse(reply.replaceAll('@HOME@',m.params.pacerHome))});}}`;
const accounts = {
  lab: { name: "lab", connection: { api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "file", models: [{ id: "m", context: 100, output: 10, tools: true }] } },
  open: { name: "open", connection: { api: "openai-compatible", base_url: "http://127.0.0.1:9/v1", key: "none", models: [] } },
} as never;

/** A flag-off or flag-on home serving a bundled plugin (the endpoint plugin from source by default) or a scripted child. */
async function bundledSetup(flag: boolean, child: { script?: string } = {}, plugin = endpoints) {
  const home = tmpDir();
  const pacerHome = join(home, ".pacer");
  mkdirSync(join(pacerHome, "run"), { recursive: true, mode: 0o700 });
  const path = join(pacerHome, "run", "host.sock");
  const ctx: Ctx = fakeCtx({ home, pacerHome, env: { PATH: process.env.PATH, ...(flag ? { PACER_HOST_SOCKET: path } : {}) } });
  const argv = child.script ? [process.execPath, "-e", child.script] : [process.execPath, endpointScript];
  const registry = new PluginRegistry({ bundled: [plugin], eventPumpMs: 0,
    spawnBundled: () => ({ argv, cwd: home, env: { PATH: process.env.PATH! } }) });
  registries.push(registry);
  const relay = flag ? await relayOwner(path) : undefined;
  if (relay) relays.push(relay);
  return { ctx, registry, relay };
}

test("flag-on endpoint.launchEnv with empty bindings writes the config through Core and matches flag-off byte for byte", async () => {
  const runs = [];
  for (const flag of [false, true]) {
    const { ctx, registry, relay } = await bundledSetup(flag);
    const settings = await endpointLaunchSettings(ctx, accounts, "lab", registry);
    const config = settings.env.OPENCODE_CONFIG!;
    const relative = (text: string) => text.replaceAll(ctx.pacerHome, "$PACER_HOME");
    runs.push({ settings: JSON.parse(relative(JSON.stringify(settings))), config: relative(readFileSync(config, "utf8")),
      mode: statSync(config).mode & 0o777, relay });
  }
  const [off, on] = runs;
  expect(on!.settings).toEqual({ env: { OPENCODE_CONFIG: "$PACER_HOME/opencode/opencode.json" }, secretEnv: { PACER_KEY_LAB: "endpoint:lab" } });
  expect(on!.settings).toEqual(off!.settings);
  expect(on!.config).toBe(off!.config);
  expect(on!.mode).toBe(off!.mode);
  // Core answers the issued writes; the owner is issued none, and no credential binding crosses.
  const [call] = on!.relay!.calls;
  expect(call.method).toBe("endpoint.launchEnv");
  expect(call.authority.resources.writes ?? []).toEqual([]);
  expect(call.coreMethods).toEqual(["capability.fs.write", "capability.fs.mkdir", "capability.fs.remove", "capability.secrets.resolve", "capability.identity.sign"]);
  expect(on!.relay!.forwarded).toEqual(["capability.fs.mkdir", "capability.fs.write"]);
  expect(on!.relay!.refused).toEqual([]);
  expect(JSON.stringify(call)).not.toContain("credentialBindings");
});

// Answers hello as `id` serving `point`, then each call by sending every capability request in turn and replying with what it got.
const askScript = (id: string, point: string, asks: [string, unknown][]) => `const asks=${JSON.stringify(asks)};const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let call,answers=[];const ask=()=>answers.length<asks.length?send({id:900+answers.length,method:asks[answers.length][0],params:asks[answers.length][1]}):send({id:call,result:{answers}});for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:m.params.protocol,id:${JSON.stringify(id)},version:m.params.manifest.version,contributes:[${JSON.stringify(point)}]}});else if(m.method&&m.id!==undefined){call=m.id;answers=[];ask();}else if(m.id>=900){answers.push(m.error?{code:m.error.data?.code,message:m.error.message}:{value:m.result});ask();}}}`;
const resolves = (refs: string[]): [string, unknown][] => refs.map(ref => ["capability.secrets.resolve", { ref }]);
const assistantPlugin = BUNDLED.find(plugin => plugin.manifest.id === "pacer-assistant")!;
const ASSISTANT_KEY = "sk-fake-assistant-fixture-key";

test("flag-on Core answers the assistant's endpoint key on its own call exactly as flag-off, and only that key", async () => {
  const outcomes = [];
  for (const flag of [false, true]) {
    const { ctx, registry, relay } = await bundledSetup(flag, { script: askScript("pacer-assistant", "assistant", resolves(["endpoint:lab", "endpoint/lab", "endpoint:open", "env:HOME"])) }, assistantPlugin);
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n  lab: {kind: endpoint, usage: unmetered, connection: {api: openai-compatible, base_url: "http://127.0.0.1:9/v1", key: file, models: [{id: m, context: 100, output: 10, tools: false}]}}\nrunners:\n  opencode#lab: {model: m}\n`, { mode: 0o600 });
    mkdirSync(join(ctx.pacerHome, "secrets"), { recursive: true, mode: 0o700 });
    writeFileSync(join(ctx.pacerHome, "secrets", "lab.key"), ASSISTANT_KEY, { mode: 0o600 });
    const { writeSettings } = await import("../src/assistant/store");
    writeSettings(ctx, { runner: "opencode#lab", account: "lab", expect_rev: 1 });
    outcomes.push(await registry.call(ctx, "pacer-assistant", "assistant.respond", {}, { deadlineMs: 10000 }));
    if (relay) {
      expect(relay.calls.map(call => call.coreMethods)).toEqual([["capability.secrets.resolve", "capability.identity.sign"]]);
      expect(relay.forwarded).toEqual(Array(4).fill("capability.secrets.resolve"));
      expect(JSON.stringify(relay.calls)).not.toContain(ASSISTANT_KEY);
      expect(relay.calls[0].authority.owning).toBe(false);
    }
  }
  const denied = { code: "capability_denied", message: "That secret is not the assistant's account key." };
  expect(outcomes[0]).toEqual({ answers: [{ value: { value: ASSISTANT_KEY } }, { value: { value: ASSISTANT_KEY } }, denied, denied] });
  expect(outcomes[1]).toEqual(outcomes[0]);
});

test("flag-on Core refuses the assistant's key to another plugin with the flag-off text, before reading it", async () => {
  const outcomes = [];
  for (const flag of [false, true]) {
    const { ctx, registry, relay } = await bundledSetup(flag, { script: askScript("pacer-endpoints", "endpoint", resolves(["endpoint:lab"])) });
    outcomes.push(await registry.call(ctx, "pacer-endpoints", "endpoint.launchEnv", { account: null, accounts: [], pacerHome: ctx.pacerHome }, {
      resources: { reads: [], commands: [], stores: [] }, credentialBindings: [] }));
    if (relay) expect(relay.forwarded).toEqual(["capability.secrets.resolve"]);
  }
  expect(outcomes[0]).toEqual({ answers: [{ code: "capability_denied", message: "plugin pacer-endpoints may not resolve assistant secrets" }] });
  expect(outcomes[1]).toEqual(outcomes[0]);
});

test("flag-on Core signs with the machine key for a declared purpose and audits it, as flag-off", async () => {
  const { clearIdentityCache, setIdentityPlatformForTests } = await import("../src/identity/store");
  const { verifyFrom } = await import("../src/identity/sign");
  const { identityAuditPath } = await import("../src/identity/audit");
  const signer = { manifest: manifestSchema.parse({ id: "fx-signer", version: "1.0.0", publisher: "test", host: "^1.6", contributes: { diagnostic: {} },
    capabilities: [{ name: "identity.sign", scopes: ["greeting"] }] }), main: async () => ({}) } as never;
  const payload = Buffer.from("hello").toString("base64");
  const outcomes = [];
  for (const flag of [false, true]) {
    clearIdentityCache(); setIdentityPlatformForTests("linux");
    const { ctx, registry, relay } = await bundledSetup(flag, { script: askScript("fx-signer", "diagnostic", [
      ["capability.identity.sign", { purpose: "greeting", payload }], ["capability.identity.sign", { purpose: "other", payload }]]) }, signer);
    const { answers: [signed, refused] } = await registry.call(ctx, "fx-signer", "diagnostic.ping", {}, { deadlineMs: 10000 }) as { answers: any[] };
    expect(verifyFrom(signed.value.machineId, "fx-signer", "greeting", Buffer.from("hello"), Buffer.from(signed.value.signature, "base64"))).toBe(true);
    const audit = readFileSync(identityAuditPath(ctx), "utf8").trim().split("\n").map(line => JSON.parse(line).outcome);
    outcomes.push({ refused, audit });
    if (relay) expect(relay.calls.map(call => call.coreMethods)).toEqual([["capability.identity.sign"]]);
  }
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(outcomes[0]!.refused.code).toBe("capability_denied");
  expect(outcomes[0]!.audit).toEqual(["signed", "refused"]);
});

test("flag-on Core refuses an undeclared signature request and audits the refusal, as flag-off", async () => {
  const { identityAuditPath } = await import("../src/identity/audit");
  const unsigned = { manifest: manifestSchema.parse({ id: "fx-unsigned", version: "1.0.0", publisher: "test", host: "^1.6", contributes: { diagnostic: {} },
    capabilities: [{ name: "log" }] }), main: async () => ({}) } as never;
  const outcomes = [];
  for (const flag of [false, true]) {
    const { ctx, registry, relay } = await bundledSetup(flag, { script: askScript("fx-unsigned", "diagnostic", [
      ["capability.identity.sign", { purpose: "greeting", payload: Buffer.from("hello").toString("base64") }]]) }, unsigned);
    const { answers } = await registry.call(ctx, "fx-unsigned", "diagnostic.ping", {}, { deadlineMs: 10000 }) as { answers: unknown[] };
    const audit = readFileSync(identityAuditPath(ctx), "utf8").trim().split("\n").map(line => {
      const { at: _at, ...entry } = JSON.parse(line);
      return entry;
    });
    outcomes.push({ answers, audit });
    if (relay) expect(relay.forwarded).toEqual(["capability.identity.sign"]);
  }
  expect(outcomes[0]).toEqual({ answers: [{ code: "capability_denied", message: "plugin fx-unsigned did not declare identity.sign" }],
    audit: [{ pluginId: "fx-unsigned", purpose: "greeting", outcome: "refused", reason: "capability not declared" }] });
  expect(outcomes[1]).toEqual(outcomes[0]);
});

test("flag-on endpoint launch settings get the flag-off env and secretEnv validation", async () => {
  const path = "@HOME@/opencode/opencode.json";
  for (const [name, reply, refusal] of [
    ["owned", { env: { OPENCODE_CONFIG: path }, secretEnv: { PACER_KEY_LAB: "endpoint:lab" } }, undefined],
    ["outside config", { env: { OPENCODE_CONFIG: "/outside" }, secretEnv: { PACER_KEY_LAB: "endpoint:lab" } }, "endpoint plugin returned unowned launch settings"],
    ["extra env", { env: { OPENCODE_CONFIG: path, EXTRA: "value" }, secretEnv: { PACER_KEY_LAB: "endpoint:lab" } }, "endpoint plugin returned unowned launch settings"],
    ["other key", { env: { OPENCODE_CONFIG: path }, secretEnv: { PACER_KEY_LAB: "endpoint:other" } }, "endpoint plugin returned unowned launch settings"],
    ["missing key", { env: { OPENCODE_CONFIG: path }, secretEnv: {} }, "endpoint plugin returned unowned launch settings"],
    ["malformed", { env: "OPENCODE_CONFIG" }, "endpoint plugin returned invalid launch settings"],
  ] as const) {
    const outcomes = [];
    for (const flag of [false, true]) {
      const { ctx, registry } = await bundledSetup(flag, { script: launchScript(reply) });
      outcomes.push(await endpointLaunchSettings(ctx, accounts, "lab", registry)
        .then(value => JSON.parse(JSON.stringify(value).replaceAll(ctx.pacerHome, "@HOME@")), (error: CoreError) => ({ code: error.code, message: error.message })));
    }
    expect([name, outcomes[1]]).toEqual([name, outcomes[0]]);
    expect([name, outcomes[1]]).toEqual([name, refusal ? { code: "plugin_refused", message: refusal } : reply]);
  }
});

test("flag-on refuses non-empty credential bindings without dialing, and nothing secret is sealed", async () => {
  const { ctx, registry, relay } = await bundledSetup(true);
  const key = "sk-fake-never-crosses";
  await expect(discoverEndpointModels(ctx, { baseUrl: "http://127.0.0.1:9/v1", key }, registry))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: "endpoint.models needs credential bindings, which the native process owner bridge does not carry" });
  await expect(registry.call(ctx, "pacer-endpoints", "endpoint.launchEnv", { account: null, accounts: [], pacerHome: ctx.pacerHome }, {
    resources: { reads: [], commands: [], stores: [] }, credentialBindings: [{ ref: "endpoint:lab", resolve: async () => key }],
  })).rejects.toMatchObject({ code: "plugin_unavailable", message: "endpoint.launchEnv needs credential bindings, which the native process owner bridge does not carry" });
  expect(relay!.calls).toEqual([]);
});

const unavailable = (method: string) => ({ code: "plugin_unavailable", message: `${method} needs credential bindings, which the native process owner bridge does not carry` });

// Only endpoint.launchEnv crosses with an empty list; these keyless calls keep the refusal they had before it did.
test("flag-on keeps refusing keyless endpoint.models without dialing", async () => {
  const { ctx, registry, relay } = await bundledSetup(true);
  await expect(discoverEndpointModels(ctx, { baseUrl: "http://127.0.0.1:9/v1", timeoutMs: 500 }, registry)).rejects.toMatchObject(unavailable("endpoint.models"));
  expect(relay!.calls).toEqual([]);
});

test("flag-on keeps refusing keyless classifier.ask without dialing", async () => {
  const classify = BUNDLED.find(plugin => plugin.manifest.id === "pacer-classify")!;
  const { ctx, registry, relay } = await bundledSetup(true, { script: childScript }, classify);
  const keyless = validateClassifier({ adapters: { ollama: { base_url: "http://127.0.0.1:9/v1", model: "m" } } }, {});
  for (const adapter of ["ollama", "rules"] as const) {
    await expect(registry.call(ctx, "pacer-classify", "classifier.ask", {
      adapter, state: "{}", question: { type: "yesno", id: "q", instructions: "q" }, timeoutMs: 1000, config: {},
    }, { deadlineMs: 2000, classifierConfig: keyless })).rejects.toMatchObject(unavailable("classifier.ask"));
  }
  expect(relay!.calls).toEqual([]);
});

const orcaProvider = BUNDLED.find(plugin => plugin.manifest.id === "pacer-exec-orca")!;
// Answers hello as pacer-exec-orca, then every call with `reply`, after a `$/progress` for that call when `progress` is set.
const executorScript = (reply: unknown, progress?: unknown) => `const reply=${JSON.stringify(JSON.stringify(reply))},progress=${JSON.stringify(JSON.stringify(progress ?? null))};const r=Bun.stdin.stream().getReader();let b='';const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));for(;;){const {value,done}=await r.read();if(done)break;b+=new TextDecoder().decode(value);while(b.includes('\\n')){const i=b.indexOf('\\n'),m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='plugin.hello')send({id:m.id,result:{protocol:m.params.protocol,id:'pacer-exec-orca',version:m.params.manifest.version,contributes:['executor']}});else if(m.method&&m.id!==undefined){if(JSON.parse(progress))send({method:'$/progress',params:{id:m.id,event:JSON.parse(progress)}});send({id:m.id,result:JSON.parse(reply)});}}}`;
/** The Orca attempt call `runOrcaAttempt` makes: a sealed orcaAttempt and no progress owner. */
const orcaAttemptCall = (ctx: Ctx, registry: PluginRegistry) => registry.call(ctx, "pacer-exec-orca", "executor.run",
  { task: { id: "t-orca", rev: 1 }, attempt: 1, runDir: 1, orca: { executor: "codex", model: null, timeoutMs: 1000 } },
  { deadlineMs: 5000, resources: { reads: [], commands: [], stores: [],
    orcaAttempt: { taskId: "t-orca", attempt: 1, providerId: "pacer-exec-orca", executor: "codex", session: crypto.randomUUID() } } });
const orcaInspectCall = (ctx: Ctx, registry: PluginRegistry) => registry.call(ctx, "pacer-exec-orca", "executor.sessionState",
  { taskId: "t-orca", attempt: 1 }, { deadlineMs: 5000, resources: { reads: [], commands: [], stores: [],
    orcaLive: { taskId: "t-orca", attempt: 1, providerId: "pacer-exec-orca", worker: "ctx_live", terminal: "term_live", action: "inspect" } } });
const outcome = (call: Promise<unknown>) => call.then(value => ({ value }), (error: CoreError) => ({ code: error.code, message: error.message }));

test("flag-on refuses an invalid executor.run or executor.sessionState result with the flag-off text", async () => {
  for (const [name, call] of [["executor.run", orcaAttemptCall], ["executor.sessionState", orcaInspectCall]] as const) {
    const outcomes = [];
    for (const flag of [false, true]) {
      const { ctx, registry, relay } = await bundledSetup(flag, { script: executorScript({ orca: "not a disposition", state: "gone" }) }, orcaProvider);
      outcomes.push(await outcome(call(ctx, registry)));
      if (relay) expect([name, relay.calls.map(sealed => sealed.method)]).toEqual([name, [name]]);
    }
    expect([name, outcomes[1]]).toEqual([name, { code: "plugin_refused", message: "usage reader returned an invalid reading" }]);
    expect([name, outcomes[1]]).toEqual([name, outcomes[0]]);
  }
});

test("progress during an Orca attempt fails it with the owner off, and the native owner drops it", async () => {
  const disposition = { orca: { fallback: { reason: "no worker" } } };
  const script = executorScript(disposition, { kind: "spawned", pid: 4242 });
  const off = await bundledSetup(false, { script }, orcaProvider);
  expect(await outcome(orcaAttemptCall(off.ctx, off.registry))).toEqual({ code: "plugin_refused", message: "invalid or unhandled executor progress" });
  const on = await bundledSetup(true, { script }, orcaProvider);
  expect(await outcome(orcaAttemptCall(on.ctx, on.registry))).toEqual({ value: disposition });
  expect(on.relay!.dropped).toEqual(["$/progress"]);
});

test("the relay owner refuses a sealed Core method a child asks for before its hello reply, as the owner's hello gate does", async () => {
  // The child asks for a sealed write while answering plugin.hello, then serves the launch normally.
  const early = `console.log(JSON.stringify({jsonrpc:'2.0',id:'early',method:'capability.fs.mkdir',params:{path:'/'}}));`;
  const reply = { env: { OPENCODE_CONFIG: "@HOME@/opencode/opencode.json" }, secretEnv: { PACER_KEY_LAB: "endpoint:lab" } };
  const { ctx, registry, relay } = await bundledSetup(true, { script: early + launchScript(reply) });
  await endpointLaunchSettings(ctx, accounts, "lab", registry);
  expect(relay!.refused).toEqual(["capability.fs.mkdir"]);
  expect(relay!.forwarded).toEqual([]);
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

test("flag-on stages a planner result above the 768 KiB limit from $/resultChunk pieces, and keeps smaller results on one frame", async () => {
  // Runs one install per size: below the serialized 768 KiB boundary the owner returns
  // the result on a single frame (nothing forwarded to Core); at and above it the child
  // sends $/resultChunk pieces that Core stages with the flag-off bounds and ordering,
  // then a `_chunkedResult` completion, so the assembled value is returned intact.
  const runCase = async (pad: number) => {
    const { ctx, folder, path, spawned, options } = plannerSetup();
    const payload = { schema: 1, pad: "x".repeat(pad) };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8");
    const chunk = 196608;
    const pieces = encoded.length > 768 * 1024 ? Math.ceil(encoded.length / chunk) : 0;
    const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
    const owner = await forwardingOwner(path, answers => {
      const i = answers.length;
      if (i < pieces) return { method: "$/resultChunk", params: { request: 1, offset: i * chunk, base64: encoded.subarray(i * chunk, (i + 1) * chunk).toString("base64") } };
      return undefined;
    }, pieces ? { _chunkedResult: { bytes: encoded.length } } : payload);
    const value = await options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder });
    await lease.dispose();
    return { value, chunkFrames: owner.answers.length, spawned };
  };
  // Below the limit: one complete frame, nothing chunked.
  const below = await runCase(600 * 1024);
  expect(below.value).toEqual({ schema: 1, pad: "x".repeat(600 * 1024) });
  expect(below.chunkFrames).toBe(0);
  expect(below.spawned).toEqual([]);
  // At the limit: the serialized result edges just over 768 KiB, so it is chunked and assembled.
  const at = await runCase(768 * 1024);
  expect(at.chunkFrames).toBeGreaterThan(0);
  expect(at.value).toEqual({ schema: 1, pad: "x".repeat(768 * 1024) });
  // Above the limit: several pieces, all staged, assembled end to end.
  const above = await runCase(1300 * 1024);
  expect(above.chunkFrames).toBeGreaterThan(1);
  expect(above.value).toEqual({ schema: 1, pad: "x".repeat(1300 * 1024) });
});

test("flag-on refuses a chunk on a read-only planner call that only sealed fs reads, keeping the plain limit", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const folder = join(ctx.home, ".claude");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "settings.json"), "ready");
  const input = { agent: "claude-code", home: ctx.home, pacerHome: ctx.pacerHome, binary: null,
    env: { now: ctx.now, pacerArgv: ["pacer"], plannerKey: "claude-code", folder }, prior: { planner: "claude-code", files: [] } };
  const lease = new PlannerResources(ctx, { purpose: "preview", cwd: ctx.home, binaries: [], roots: [folder] });
  const { answers, requests } = await forwardingOwner(path, answers => [
    { method: "$/resultChunk", params: { request: 1, offset: 0, base64: Buffer.from("{}").toString("base64") } },
    undefined,
  ][answers.length], { schema: 1 });
  await expect(registry.call(ctx, "fx-native", "planner.plan", input, { plannerResources: lease, accountHome: folder })).rejects.toMatchObject({ code: "capability_denied" });
  await lease.dispose();
  await waitUntil(() => answers.length > 0);
  expect(answers[0]).toMatchObject({ data: { code: "capability_denied" } });
  // A read-only planner call seals only the fs reads, never `$/resultChunk`.
  expect(requests[0].params.coreMethods).not.toContain("$/resultChunk");
  expect(spawned).toEqual([]);
});

test("flag-on refuses a chunk on a call that never negotiated chunked results", async () => {
  const { ctx, registry, path, spawned } = setup("fake");
  const { answers, requests } = await forwardingOwner(path, answers => [
    { method: "$/resultChunk", params: { request: 1, offset: 0, base64: Buffer.from("{}").toString("base64") } },
    undefined,
  ][answers.length], { ok: true });
  await expect(registry.call(ctx, "fx-native", "diagnostic.ping", {})).rejects.toMatchObject({ code: "capability_denied" });
  await waitUntil(() => answers.length > 0);
  expect(answers[0]).toMatchObject({ data: { code: "capability_denied" } });
  // No usage/effect to negotiate for: Core sealed no transport and answers the chunk itself.
  expect(requests[0].params.coreMethods).toEqual(["capability.identity.sign"]);
  expect(spawned).toEqual([]);
});

test("flag-on Core answers only the methods it sealed for the call, whatever the owner forwards", async () => {
  const { ctx, registry, path } = setup("fake");
  const asks = [
    { method: "capability.fs.read", params: { path: join(ctx.home, "x") } },
    { method: "capability.usage.state.begin", params: { id: "x", kind: "cache" } },
    { method: "capability.log", params: { level: "info", message: "x" } },
    { method: "capability.secrets.resolve", params: { ref: "endpoint:lab" } },
  ];
  const { answers, requests } = await forwardingOwner(path, answers => asks[answers.length], { ok: true });
  await registry.call(ctx, "fx-native", "diagnostic.ping", {});
  expect(requests[0].params.coreMethods).toEqual(["capability.identity.sign"]);
  expect(answers).toEqual(asks.map(({ method }) => expect.objectContaining({
    message: `${method} is not served by Core for this call`, data: expect.objectContaining({ code: "capability_denied" }) })));
});

test("flag-on refuses stale chunks without ending the current call", async () => {
  const { ctx, folder, path, options } = plannerSetup();
  const owner = await forwardingOwner(path, answers => answers.length === 0
    ? { method: "$/resultChunk", params: { request: -1, offset: 0, base64: "e30=" } }
    : undefined, { schema: 1 });
  const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
  try {
    expect(await options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder })).toEqual({ schema: 1 });
  } finally { await lease.dispose(); }
  expect(owner.answers[0]).toMatchObject({ data: { code: "capability_denied" } });
});

test("flag-on refuses a plain result after chunks were staged", async () => {
  const { ctx, folder, path, spawned, options } = plannerSetup();
  // The owner (recording Core's role) sends one accepted chunk then a plain final
  // reply; Core must refuse the plain result once a transfer has started.
  await forwardingOwner(path, answers => answers.length < 1
    ? { method: "$/resultChunk", params: { request: 1, offset: 0, base64: Buffer.from("{}").toString("base64") } }
    : undefined, { schema: 1 });
  const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
  try {
    await expect(options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder }))
      .rejects.toMatchObject({ code: "plugin_refused", message: "incomplete or unnegotiated chunked result" });
  } finally { await lease.dispose(); }
  expect(spawned).toEqual([]);
});

test("flag-on rejects the pending call on its first refused chunk even without a final reply", async () => {
  for (const params of [
    { request: 1, offset: 0, base64: "!" },
    { request: 1, offset: 5, base64: "e30=" },
    { request: 1, offset: 0, base64: Buffer.alloc(262145).toString("base64") },
  ]) {
    const { ctx, folder, path, options } = plannerSetup();
    const owner = await forwardingOwner(path, () => ({ method: "$/resultChunk", params: { ...params } }), { schema: 1 }, true);
    const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
    try {
      await expect(options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder }))
        .rejects.toMatchObject({ code: "invalid_input" });
    } finally { await lease.dispose(); }
    await waitUntil(owner.closed);
  }
});

test("flag-on applies flag-off chunk bounds: oversized chunk, non-contiguous and duplicate offsets, and an over-16 MiB total", async () => {
  const CHUNK = 262144;
  const weight = Buffer.from("{}").toString("base64");
  const chunk = (params: { request: number; offset: number; base64: string }): Ask => ({ method: "$/resultChunk", params });
  const runCase = async (chunks: Ask[], value: unknown = { schema: 1 }) => {
    const { ctx, folder, path, spawned, options } = plannerSetup();
    const { answers, requests } = await forwardingOwner(path, answers => chunks[answers.length] ?? undefined, value);
    const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
    try {
      await expect(options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder }))
        .rejects.toMatchObject({ code: "invalid_input" });
    } finally { await lease.dispose(); }
    await waitUntil(() => answers.length === chunks.length);
    return { answers: answers as any[], requests, spawned };
  };
  // A chunk over 256 KiB is refused (the `CHUNK` bound).
  const oversized = await runCase([chunk({ request: 1, offset: 0, base64: Buffer.alloc(CHUNK + 1, 97).toString("base64") })]);
  expect(oversized.answers[0]).toMatchObject({ data: { code: "invalid_input" } });
  expect(oversized.spawned).toEqual([]);
  // A non-contiguous offset (skips 0) is refused.
  const nonContiguous = await runCase([chunk({ request: 1, offset: 5, base64: weight })]);
  expect(nonContiguous.answers[0]).toMatchObject({ data: { code: "invalid_input" } });
  expect(nonContiguous.requests[0].params.coreMethods).toContain("$/resultChunk");
  // A duplicate offset (an out-of-order replay after a staged chunk) is refused.
  const duplicate = await runCase([
    chunk({ request: 1, offset: 0, base64: weight }),
    chunk({ request: 1, offset: 0, base64: weight }),
  ], { _chunkedResult: { bytes: 2 } });
  expect(duplicate.answers[0]).toEqual({ bytes: 2 });
  expect(duplicate.answers[1]).toMatchObject({ data: { code: "invalid_input" } });
  // An over-16 MiB total is refused: 64 accepted chunk frames put 16 MiB on the
  // file, so the 65th is rejected before it is admitted.
  const big = Array.from({ length: 65 }, (_, i) => chunk({ request: 1, offset: i * CHUNK, base64: Buffer.alloc(CHUNK, 97).toString("base64") }));
  const overflow = await runCase(big);
  expect(overflow.answers.length).toBe(65);
  expect(overflow.answers[64]).toMatchObject({ data: { code: "invalid_input" } });
});

const stagingDirs = () => readdirSync(tmpdir()).filter(name => name.startsWith("pacer-plugin-result-"));

test("flag-on fails the call and cleans up staged chunks when the owner drops the socket mid-chunk", async () => {
  const { ctx, folder, path, spawned, options } = plannerSetup();
  const server = createServer(authed(socket => {
    // Read the call, forward one accepted chunk, then drop the socket before the
    // final completion so the call ends mid-transfer.
    socket.once("data", () => {
      socket.write(JSON.stringify({
        jsonrpc: "2.0", id: "core-1", method: "$/resultChunk",
        params: { request: 1, offset: 0, base64: Buffer.from("{}").toString("base64") },
      }) + "\n");
      socket.once("data", () => socket.destroy());
    });
  }));
  servers.push(server);
  await new Promise<void>(done => server.listen(path, done));
  const lease = new PlannerResources(ctx, { purpose: "install", cwd: ctx.home, binaries: ["fx-planner"], roots: [folder] });
  const before = stagingDirs();
  try {
    await expect(options.registry.call(ctx, "fx-planner", "planner.install", {}, { plannerResources: lease, accountHome: folder }))
      .rejects.toMatchObject({ code: "plugin_unavailable" });
  } finally { await lease.dispose(); }
  await new Promise(done => setTimeout(done, 100));
  expect(stagingDirs().length).toBe(before.length);
  expect(spawned).toEqual([]);
});
