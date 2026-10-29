import { expect, test } from "bun:test";
import { serve } from "../packages/plugin-sdk/src/index";

class Input implements AsyncIterable<string> {
  private queue: (string | null)[] = [];
  private reader?: (value: string | null) => void;
  push(value: unknown) { const line = value === null ? null : JSON.stringify({ jsonrpc: "2.0", ...value as object });
    if (this.reader) { const reader = this.reader; this.reader = undefined; reader(line); } else this.queue.push(line); }
  async *[Symbol.asyncIterator]() { for (;;) { const next = this.queue.length ? this.queue.shift()! : await new Promise<string | null>(resolve => { this.reader = resolve; }); if (next === null) return; yield next; } }
}
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) throw Error("fixture wait timed out"); await Bun.sleep(1); } }
const manifest = { id: "public-fixture", version: "1.0.0", publisher: "test", host: "^1.5", contributes: { usage: {} } };

test("SDK capability requests keep each overlapping handler's own call metadata", async () => {
  const input = new Input(), out: any[] = [];
  const running = serve({ manifest, input, handlers: { "usage.read": async (params: any, host) => host.call("capability.fs.read", { path: params.path }) },
    write: line => { const message = JSON.parse(line); out.push(message); if (message.method) input.push({ id: message.id, result: { path: message.params.path } }); } });
  input.push({ id: 1, method: "plugin.hello", params: { protocol: "1.1.0", features: [], manifest, config: {}, grants: [] } });
  input.push({ id: 2, method: "usage.read", _meta: { capabilityCall: "account-a-token" }, params: { path: "/fixture/a" } });
  input.push({ id: 3, method: "usage.read", _meta: { capabilityCall: "account-b-token" }, params: { path: "/fixture/b" } });
  await until(() => out.some(x => x.id === 3 && x.result)); input.push(null); await running;
  expect(out.filter(x => x.method).map(x => ({ path: x.params.path, meta: x._meta }))).toEqual([
    { path: "/fixture/a", meta: { capabilityCall: "account-a-token" } }, { path: "/fixture/b", meta: { capabilityCall: "account-b-token" } },
  ]);
});

test("SDK cancellation rejects owned pending capabilities and late handler capabilities", async () => {
  const input = new Input(), out: any[] = [];
  const running = serve({ manifest, input, handlers: { "usage.read": async (_params, host) => {
    try { await host.call("capability.fs.read", { path: "/fixture/a" }); } catch { /* Parent cancellation revokes the helper. */ }
    return host.call("capability.fs.read", { path: "/fixture/late" });
  } }, write: line => { out.push(JSON.parse(line)); } });
  input.push({ id: 1, method: "plugin.hello", params: { protocol: "1.1.0", manifest, config: {}, grants: [] } });
  input.push({ id: 2, method: "usage.read", _meta: { capabilityCall: "expired-token" }, params: {} });
  await until(() => out.some(x => x.method === "capability.fs.read"));
  input.push({ method: "$/cancel", params: { id: 2 } });
  await until(() => out.some(x => x.id === 2 && x.error)); input.push(null); await running;
  expect(out.filter(x => x.method).map(x => x.params.path)).toEqual(["/fixture/a"]);
  expect(out.find(x => x.id === 2).error.data.code).toBe("plugin_unavailable");
});

test("host RPC carries correlation to capability dispatch and routes only live progress", async () => {
  const { PluginProcess } = await import("../src/plugins/process");
  const { tmpDir } = await import("./helpers");
  const { join } = await import("node:path");
  const {createCallAuthority}=await import("../src/plugins/authority"),{fakeCtx}=await import("./helpers");
  const authority=createCallAuthority(fakeCtx(),{reads:[],commands:[],stores:[]},{deadlineMs:Date.now()+5000});
  const metadata: unknown[] = [], progress: unknown[] = [];
  const peer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/peer.ts")], cwd: tmpDir(), env: {} }, {
    onRequest: async (_method: string, _params: unknown, meta?: unknown) => { metadata.push(meta); return { observed: true }; },
    onStderr: () => {}, onExit: () => {},
  });
  try {
    expect(await (peer.request as any)("fixture.capability", {}, 1000, { authority, metadata: { capabilityCall: authority.token } })).toEqual({ observed: true });
    expect(metadata).toEqual([{ capabilityCall: authority.token }]);
    await (peer.request as any)("fixture.progress", {}, 1000, { onProgress: (value: unknown) => progress.push(value) });
    await Bun.sleep(5);
    expect(progress).toEqual([{ value: 7 }]);
  } finally { await peer.terminate();await authority.revoke(); }
});

test("host RPC deadline zero is explicit no timer and caller abort ends pending work", async () => {
  const { PluginProcess } = await import("../src/plugins/process");
  const { tmpDir } = await import("./helpers");
  const { join } = await import("node:path");
  const peer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/peer.ts")], cwd: tmpDir(), env: {} }, {
    onRequest: async () => ({}), onStderr: () => {}, onExit: () => {},
  });
  try {
    for (const code of ["not_found", "too_large"]) await expect(peer.request("fixture.error", { code }, 1000)).rejects.toMatchObject({ code });
    await expect(peer.request("fixture.error", { code: "internal" }, 1000)).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(await peer.request("fixture.delay", {}, 0)).toEqual({ ok: true });
    const controller = new AbortController();
    const waiting = (peer.request as any)("fixture.delay", {}, 1000, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "plugin_unavailable" });
  } finally { await peer.terminate(); }
});


test("capability reply serialization cannot send data after its owning authority expires", async () => {
  const { PluginProcess } = await import("../src/plugins/process");
  const { createCallAuthority } = await import("../src/plugins/authority");
  const { fakeCtx } = await import("./helpers");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const ctx = fakeCtx(), marker = join(ctx.home, "capability-reply-received");
  let encoded = false;
  const peer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/peer.ts")], cwd: ctx.home, env: {} }, {
    onRequest: async () => ({ toJSON: () => { encoded = true; const end = Date.now() + 250; while (Date.now() < end) {} return { observed: true }; } }),
    onStderr: () => {}, onExit: () => {},
  });
  const authority = createCallAuthority(ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 200 });
  try {
    await expect(peer.request("fixture.capability", { marker }, 2000, { authority, signal: authority.signal, metadata: { capabilityCall: authority.token } })).rejects.toBeDefined();
    await Bun.sleep(30);
    expect(encoded).toBe(true); expect(existsSync(marker)).toBe(false);
  } finally { await authority.revoke(); await peer.terminate(); }
});
