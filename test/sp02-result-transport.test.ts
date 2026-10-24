import { expect, test } from "bun:test";
import * as protocol from "../src/plugins/protocol";

test("negotiated result chunks have explicit bounded request and completion schemas", () => {
  const chunk = (protocol as any).resultChunkParams, completion = (protocol as any).chunkedResult;
  expect(chunk).toBeDefined(); expect(completion).toBeDefined();
  expect(chunk.parse({ request: 2, offset: 0, base64: Buffer.alloc(262144).toString("base64") })).toHaveProperty("request", 2);
  expect(chunk.safeParse({ request: 2, offset: 0, base64: Buffer.alloc(262147).toString("base64") }).success).toBe(false);
  expect(chunk.safeParse({ request: 2, offset: -1, base64: "" }).success).toBe(false);
  expect(completion.parse({ _chunkedResult: { bytes: 2000000 } })).toEqual({ _chunkedResult: { bytes: 2000000 } });
});

import { join } from "node:path";
import { PluginProcess } from "../src/plugins/process";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";

async function peer() {
  const ctx = fakeCtx(), logs: string[] = [];
  const processPeer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/sdk-peer.ts")], cwd: ctx.home, env: {} }, {
    onRequest: async () => { throw Error("result chunks must be handled as transport, not capabilities"); }, onStderr: line => logs.push(line), onExit: () => {},
  });
  const hello = await processPeer.request<any>("plugin.hello", { protocol: "1.1.0", features: ["chunkedResults"], pacer: "fixture",
    manifest: { id: "large-result-fixture", version: "0.2.0", publisher: "test", host: "^1.1", contributes: { usage: {} }, capabilities: [] }, config: {}, grants: [] }, 1000);
  return { ctx, processPeer, hello, logs };
}

test("real SDK and host negotiate and assemble a >1MiB rich reading without changing unknown fields", async () => {
  const f = await peer();
  const authority = createCallAuthority(f.ctx, { reads: [], stores: [], commands: [] }, { deadlineMs: Date.now() + 3000 });
  try {
    expect(f.hello.features).toContain("chunkedResults");
    (f.processPeer as any).setFeatures(["chunkedResults"]);
    const result = await f.processPeer.request<any>("usage.read", { characters: 500000 }, 3000,
      { metadata: { capabilityCall: authority.token }, signal: authority.signal, authority } as any);
    expect(result.futureTop).toBe("retained");
    expect(result.alternatives[0].futureNested.payload).toBe("界".repeat(500000));
    expect(f.logs.filter(line => line.includes("over 1 MiB"))).toEqual([]);
  } finally { await authority.revoke(); await f.processPeer.terminate(); }
});

async function rawPeer() {
  const ctx = fakeCtx();
  const processPeer = new PluginProcess({ argv: [process.execPath, join(import.meta.dir, "fixtures/sp02-rpc/chunk-peer.ts")], cwd: ctx.home, env: {} }, {
    onRequest: async () => { throw Error("not a capability"); }, onStderr: () => {}, onExit: () => {},
  });
  await processPeer.request("plugin.hello", { protocol: "1.1.0", features: ["chunkedResults"], manifest: { id: "raw-chunk", version: "0.2.0" } }, 1000);
  (processPeer as any).setFeatures(["chunkedResults"]);
  return { ctx, processPeer };
}

test("partial JSON, wrong ownership and out-of-order chunks never become a reading", async () => {
  const f = await rawPeer();
  try {
    for (const mode of ["partial", "wrong-token", "out-of-order", "malformed"]) {
      const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 2000 });
      try {
        await expect(f.processPeer.request("usage.read", { mode }, 1000,
          { authority, signal: authority.signal, metadata: { capabilityCall: authority.token } } as any)).rejects.toBeDefined();
      } finally { await authority.revoke(); }
    }
  } finally { await f.processPeer.terminate(); }
});

test("timed-out partial transfers and late chunks cannot attach to a successor request", async () => {
  const f = await rawPeer();
  const first = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 1000 });
  const second = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 2000 });
  try {
    await expect(f.processPeer.request("usage.read", { mode: "hold" }, 20,
      { authority: first, metadata: { capabilityCall: first.token } } as any)).rejects.toMatchObject({ code: "plugin_timeout" });
    await first.revoke();
    expect(await f.processPeer.request("usage.read", { mode: "ordinary" }, 1000,
      { authority: second, metadata: { capabilityCall: second.token } } as any)).toEqual({ windows: [], capturedAt: 100, stale: false });
    await Bun.sleep(100);
    expect(await f.processPeer.request("usage.read", { mode: "ordinary" }, 1000,
      { authority: second, metadata: { capabilityCall: second.token } } as any)).toEqual({ windows: [], capturedAt: 100, stale: false });
  } finally { await first.revoke(); await second.revoke(); await f.processPeer.terminate(); }
});


test("unnegotiated chunk envelopes are refused while ordinary legacy replies remain usable", async () => {
  const f = await rawPeer();
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 2000 });
  try {
    (f.processPeer as any).setFeatures([]);
    await expect(f.processPeer.request("usage.read", { mode: "partial" }, 1000,
      { authority, metadata: { capabilityCall: authority.token } } as any)).rejects.toMatchObject({ code: "capability_denied" });
    expect(await f.processPeer.request("usage.read", { mode: "ordinary" }, 1000)).toEqual({ windows: [], capturedAt: 100, stale: false });
  } finally { await authority.revoke(); await f.processPeer.terminate(); }
});


test("correctly owned malformed chunks cannot be caught and replaced by ordinary success", async () => {
  const f = await rawPeer();
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 2000 });
  try {
    await expect(f.processPeer.request("usage.read", { mode: "malformed-caught" }, 1000,
      { authority, metadata: { capabilityCall: authority.token } } as any)).rejects.toMatchObject({ code: "invalid_input" });
  } finally { await authority.revoke(); await f.processPeer.terminate(); }
});


test("an unacknowledged admitted chunk cannot race an ordinary result past transfer ownership", async () => {
  const f = await rawPeer();
  const authority = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] }, { deadlineMs: Date.now() + 2000 });
  try {
    await expect(f.processPeer.request("usage.read", { mode: "racing" }, 1000,
      { authority, metadata: { capabilityCall: authority.token } } as any)).rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await authority.revoke(); await f.processPeer.terminate(); }
});
