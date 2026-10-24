import { expect, test } from "bun:test";
import { join } from "node:path";
import { PluginRegistry } from "../src/plugins/registry";
import { fakeCtx } from "./helpers";
const manifest = { id: "usage-fixture", version: "1.0.0", publisher: "test", host: "^1", contributes: { usage: {} }, capabilities: [], reentrant: false, tier: "free" as const };
const params = (provider: string) => ({ provider, account: null, accountHome: null, model: null, weeklyTokens: null, weeklyUsd: null,
  quotaSource: null, now: 100, readOnly: true, refresh: false });
const make = () => new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
  spawnBundled: ctx => ({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/peer.ts")], cwd: ctx.home, env: {} }) });

test("usage calls receive fresh host-owned correlation and preserve rich unknown result fields", async () => {
  const registry = make(), ctx = fakeCtx();
  try {
    const a = await registry.call<any>(ctx, manifest.id, "usage.read", params("fixture"));
    const b = await registry.call<any>(ctx, manifest.id, "usage.read", params("fixture"));
    expect(a.owned).toEqual(expect.any(String));
    expect(a.owned).not.toBe(b.owned);
    expect(a.serial).toBe(1); expect(b.serial).toBe(2);
  } finally { await registry.shutdown(); }
});

test("absolute queued usage deadlines expire without issuing a fresh request", async () => {
  const registry = make(), ctx = fakeCtx();
  try {
    const first = registry.call(ctx, manifest.id, "usage.read", params("slow"));
    const queued = (registry.call as any)(ctx, manifest.id, "usage.read", params("fixture"), { deadlineMs: 5 });
    const rejected = expect(queued).rejects.toMatchObject({ code: "plugin_timeout" });
    await first; await rejected;
    const after = await registry.call<any>(ctx, manifest.id, "usage.read", params("fixture"));
    expect(after.serial).toBe(2);
  } finally { await registry.shutdown(); }
});

test("usage authority remains finite when a caller requests the generic zero-deadline option", async () => {
  const registry = make(), ctx = fakeCtx();
  try {
    const value = await (registry.call as any)(ctx, manifest.id, "usage.read", params("fixture"), { deadlineMs: 0 });
    expect(value.owned).toEqual(expect.any(String));
  } finally { await registry.shutdown(); }
});

test("stopping a plugin still terminates its process after owned cleanup fails", async () => {
  const registry = make();
  let terminated = false;
  const entry = { authorities: new Map([["failed", { revoke: async () => { throw Error("uncertain owned cleanup"); } }]]),
    process: { terminate: async () => { terminated = true; } }, stopping: false };
  await expect((registry as any).stop(entry)).rejects.toThrow("uncertain owned cleanup");
  expect(terminated).toBe(true);
  expect(entry.process).toBeUndefined();
});


test("finite calls leave a nonreentrant queue while an infinite diagnostic still hangs", async () => {
  const registry = make(), ctx = fakeCtx(), controller = new AbortController();
  const hanging = registry.call(ctx, manifest.id, "diagnostic.ping", { hang: true }, { deadlineMs: 0, signal: controller.signal });
  const ended = hanging.catch(() => undefined);
  try {
    await Bun.sleep(50);
    const queued = registry.call(ctx, manifest.id, "usage.read", params("fixture"), { deadlineMs: 10 });
    const outcome = await Promise.race([queued.then(() => "unexpected success", e => e.code), Bun.sleep(100).then(() => "still waiting")]);
    expect(outcome).toBe("plugin_timeout");
    controller.abort(); await ended;
    expect((await registry.call<any>(ctx, manifest.id, "usage.read", params("fixture"))).serial).toBe(1);
  } finally { controller.abort(); await ended; await registry.shutdown(); }
});
