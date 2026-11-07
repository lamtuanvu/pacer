import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { CoreError } from "../src/core/errors";
import { PluginRegistry } from "../src/plugins/registry";
import { manifestSchema } from "../src/plugins/protocol";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";

const manifest = manifestSchema.parse({
  id: "fx-native", version: "1.0.0", publisher: "pacer", host: "^1.6",
  contributes: { diagnostic: {} },
  capabilities: [{ name: "fs.read", scopes: ["${ACCOUNT_HOME}/**"] }, { name: "process.spawn", scopes: ["fx-tool", "fx-missing", "fx-elsewhere"] }],
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
  expect(request.params.spawn.hello.grants).toEqual(["fs.read", "process.spawn"]);
  expect(request.params.authority.resources.reads).toEqual([{ path: note, kind: "file" }]);
  expect(request.params.authority.grants).toEqual(["fs.read", "process.spawn"]);
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
