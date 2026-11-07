import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { HostClient } from "../packages/plugin-sdk/src";
import { preparePlannerInstall } from "../packages/plugin-sdk/src/install/prepared";
import { createPlannerIO, readPlannerPrior } from "../packages/plugin-sdk/src/install/transport";
import { preparePlannerUninstallFiles } from "../packages/plugin-sdk/src/install/uninstall";
import { CoreError } from "../src/core/errors";
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
  const server = createServer(socket => {
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
  });
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
    "capability.planner.run", "capability.process.outputChunk", "capability.planner.readPriorRange"]);
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
  const { ctx, folder, path, spawned, options } = plannerSetup();
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

test("flag-on planner commands outside the transaction are refused and a consent-less connect never dials", async () => {
  const { ctx, folder, path, spawned, options } = plannerSetup();
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

test("flag-on install over the bridge is cancelled and compensates when the plugin's grant is revoked mid-call", async () => {
  const { ctx, folder, path, spawned, options } = plannerSetup();
  // `disable` needs an existing strategy file to edit (plannerSetup does not write one).
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n", { mode: 0o600 });
  // A slow pinned command widens the window between the admitted command and the final reply.
  writeFileSync(join(ctx.home, "bin", "fx-planner"), "#!/bin/sh\nsleep 0.3\nprintf '%s\\n' \"$2\" >> \"$1.log\"\n", { mode: 0o755 });
  await plannerOwner(path, { "planner.install": installHandler() });
  const promise = withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  await new Promise(done => setTimeout(done, 100));
  // Disabling the plugin revokes its authorities, same as flag-off; the registered
  // native-owner authority must be among them so the in-flight call is cancelled too.
  await options.registry.disable(ctx, "fx-planner");
  await expect(promise).rejects.toMatchObject({ code: expect.any(String) });
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on install over the bridge is cancelled when the planner configuration generation changes mid-call", async () => {
  const { ctx, folder, path, spawned, options } = plannerSetup();
  writeFileSync(join(ctx.home, "bin", "fx-planner"), "#!/bin/sh\nsleep 0.3\nprintf '%s\\n' \"$2\" >> \"$1.log\"\n", { mode: 0o755 });
  await plannerOwner(path, { "planner.install": installHandler() });
  const promise = withPlannerInstall({ ctx, pacerArgv: ["pacer"], folder }, "synthetic", options);
  await new Promise(done => setTimeout(done, 100));
  // Change the plugin's `plugins.config.<id>` slice in the strategy file directly: this is
  // what moves `e.plannerFingerprint`, the same generation `options.registry.refresh` checks
  // flag-off before admission. The native-owner path must check it too, mid-call.
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    fx-planner:\n      note: changed\n");
  options.registry.refresh(ctx);
  await expect(promise).rejects.toMatchObject({ code: expect.any(String) });
  expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("before");
  expect(existsSync(join(ctx.pacerHome, "install-manifest.json"))).toBe(false);
  expect(existsSync(join(ctx.pacerHome, "install-transaction.json"))).toBe(false);
  expect(spawned).toEqual([]);
});

test("flag-on install over the bridge compensates when the owner drops the socket after a forwarded command", async () => {
  const { ctx, folder, path, spawned, options, log } = plannerSetup();
  const server = createServer(socket => {
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
  });
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
