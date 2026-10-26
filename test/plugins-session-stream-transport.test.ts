import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { createCallAuthority } from "../src/plugins/authority";
import { PluginProcess } from "../src/plugins/process";
import { prepareSpawnAuthority } from "../src/plugins/capability-spawn";
import { answerCapability } from "../src/plugins/host";
import { fakeCtx, tmpDir } from "./helpers";

function start(deadlineMs = 5_000) {
  const authority = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + deadlineMs });
  const process = new PluginProcess({ argv: [Bun.which("bun")!, join(import.meta.dir, "fixtures", "plugin-stream-peer.ts")],
    cwd: import.meta.dir, env: { PATH: processEnvPath() } },
  { onRequest: async () => { throw Error("unexpected capability"); }, onStderr: () => {}, onExit: () => {} });
  return { authority, process };
}
const processEnvPath = () => process.env.PATH ?? "";

test("stream progress is acknowledged only after the exact owner consumes it", async () => {
  const { authority, process } = start();
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  let release!: () => void;
  const consumed = new Promise<void>(resolve => { release = resolve; });
  let seen = "";
  try {
    const result = process.request<{ code: number; bytes: number }>("hostRunner.stream", { streamId }, 3000,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId,
        consume: async bytes => { seen = bytes.toString(); await consumed; } } });
    await Bun.sleep(100);
    expect(seen).toBe("abc");
    let done = false;
    void result.then(() => { done = true; });
    expect(done).toBe(false);
    release();
    expect(await result).toEqual({ code: 0, bytes: 3 });
  } finally { await process.terminate(); await authority.revoke(); }
});

test("stream refuses a second progress frame before acknowledgement", async () => {
  const { authority, process } = start();
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    await expect(process.request("hostRunner.stream", { streamId, mode: "double" }, 3000,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } }))
      .rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await process.terminate(); await authority.revoke(); }
});

for (const mode of ["wrong-id", "wrong-token", "bad-base64"] as const) test(`stream refuses ${mode} progress authority`, async () => {
  const { authority, process } = start();
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    await expect(process.request("hostRunner.stream", { streamId, mode }, 3000,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } }))
      .rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await process.terminate(); await authority.revoke(); }
});

test("an unowned authority cannot omit the wall deadline", async () => {
  const ctx = fakeCtx(), resources = { reads: [], commands: [], stores: [] };
  expect(() => createCallAuthority(ctx, resources, { deadlineMs: Infinity })).toThrow();
  expect(() => createCallAuthority(ctx, resources, { deadlineMs: Infinity, ownerBoundStream: true })).toThrow();
  const owner = new AbortController();
  const authority = createCallAuthority(ctx, resources,
    { deadlineMs: Infinity, ownerBoundStream: true, signal: owner.signal });
  authority.assertActive();
  owner.abort();
  expect(() => authority.assertActive()).toThrow();
  await authority.revoke();
});

test("a stream progress frame without acknowledgement expires on its own deadline", async () => {
  const { authority, process } = start(10_000);
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    await expect(process.request("hostRunner.stream", { streamId, mode: "no-ack" }, 0,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } }))
      .rejects.toMatchObject({ code: "plugin_timeout" });
  } finally { await process.terminate(); await authority.revoke(); }
}, 7000);

test("host input waits for the exact plugin write acknowledgement", async () => {
  const dir = tmpDir(), ssh = join(dir, "ssh"), readyFile = join(dir, "ready");
  writeFileSync(ssh, "#!/bin/sh\nexec cat\n", { mode: 0o755 });
  const ctx = fakeCtx({ env: { ...globalThis.process.env, HOME: dir }, which: name => name === "ssh" ? ssh : null });
  const argv = ["ssh", "owned"];
  const authority = createCallAuthority(ctx, { reads: [], commands: [{ argv, timeoutMs: 1000, mode: "session-duplex" }], stores: [] },
    { deadlineMs: Date.now() + 5_000, grants: ["process.spawn"] });
  prepareSpawnAuthority(authority);
  const plugin = { id: "pacer-ssh", manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] } } as Parameters<typeof answerCapability>[1];
  const process = new PluginProcess({ argv: [Bun.which("bun")!, join(import.meta.dir, "fixtures", "plugin-stream-peer.ts")],
    cwd: import.meta.dir, env: { PATH: globalThis.process.env.PATH } },
  { onRequest: (method, params) => answerCapability(ctx, plugin, method, params, authority),
    onStderr: () => {}, onExit: () => {} });
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    const result = process.request("hostRunner.stream", { streamId, mode: "input", argv, readyFile }, 3000,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } });
    for (let i = 0; i < 100 && !existsSync(readyFile); i++) await Bun.sleep(10);
    expect(existsSync(readyFile)).toBe(true);
    const input = await process.sendStreamInput(streamId, Buffer.from("abc"));
    expect(input).toBeUndefined();
    expect(await result).toEqual({ code: 0, bytes: 3 });
  } finally { await process.terminate(); await authority.revoke(); }
});

test("host input refuses a forged acknowledgement and retires the stream", async () => {
  const { authority, process } = start();
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    const result = process.request("hostRunner.stream", { streamId, mode: "input-wrong-token" }, 3000,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } });
    void result.catch(() => {});
    await expect(process.sendStreamInput(streamId, Buffer.from("abc")))
      .rejects.toMatchObject({ code: "plugin_refused" });
    await expect(result).rejects.toMatchObject({ code: "plugin_refused" });
  } finally { await process.terminate(); await authority.revoke(); }
});

test("host input allows only one pending frame and expires without a receipt", async () => {
  const { authority, process } = start(10_000);
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  try {
    const result = process.request("hostRunner.stream", { streamId, mode: "input-no-ack" }, 0,
      { authority, metadata: { capabilityCall: authority.token }, stream: { streamId, consume: async () => {} } });
    void result.catch(() => {});
    const first = process.sendStreamInput(streamId, Buffer.from("abc"));
    await expect(process.sendStreamInput(streamId, Buffer.from("next")))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(first).rejects.toMatchObject({ code: "plugin_timeout" });
    await expect(result).rejects.toMatchObject({ code: "plugin_timeout" });
  } finally { await process.terminate(); await authority.revoke(); }
}, 7000);
