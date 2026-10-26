import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority } from "../src/plugins/authority";
import { prepareFilesystemAuthority } from "../src/plugins/capability-fs";
import { answerCapability } from "../src/plugins/host";
import type { PluginManifest } from "../src/plugins/protocol";
import { fakeCtx } from "./helpers";

test("mixed bundle scopes allow Claude without an account home and never broaden missing scopes", async () => {
  const ctx = fakeCtx(), path = join(ctx.pacerHome, "cache", "claude-rate-limits.json");
  mkdirSync(join(ctx.pacerHome, "cache"), { recursive: true }); writeFileSync(path, "{}");
  const authority = createCallAuthority(ctx, { reads: [{ path, kind: "file" }], commands: [], stores: [] }, { deadlineMs: Date.now() + 10000, grants: ["fs.read"] });
  await prepareFilesystemAuthority(authority);
  const manifest: PluginManifest = { id: "fixture", publisher: "test", version: "0.2.0", host: "^1", contributes: { usage: {} }, tier: "free", reentrant: true,
    capabilities: [{ name: "fs.read", scopes: ["${PACER_HOME}/cache/claude-rate-limits*.json", "${ACCOUNT_HOME}/sessions/**"] }] };
  try {
    expect(await answerCapability(ctx, { id: manifest.id, manifest }, "capability.fs.read", { path }, authority)).toHaveProperty("text", "{}");
    const restricted = { ...manifest, capabilities: [{ name: "fs.read" as const, scopes: ["${ACCOUNT_HOME}/sessions/**"] }] };
    await expect(answerCapability(ctx, { id: manifest.id, manifest: restricted }, "capability.fs.read", { path }, authority)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(answerCapability(ctx, { id: manifest.id, manifest }, "capability.fs.read", { path: join(ctx.pacerHome, "cache", "auth.json") }, authority)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await authority.revoke(); }
});

test("host dispatch shares one capability window across provider work and filesystem/output chunks", async () => {
  const { prepareSpawnAuthority } = await import("../src/plugins/capability-spawn");
  const ctx = fakeCtx(), path = join(ctx.home, "telemetry.json"), executable = join(ctx.home, "owned-provider");
  writeFileSync(path, "{}");
  writeFileSync(executable, `#!${process.execPath}\nsetTimeout(()=>process.stdout.write("done"),50);\n`, { mode: 0o700 });
  ctx.which = () => executable;
  const argv = ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"];
  const authority = createCallAuthority(ctx, { reads: [{ path, kind: "file" }], commands: [{ argv, timeoutMs: 1000 }], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["fs.read", "process.spawn"] });
  await prepareFilesystemAuthority(authority); prepareSpawnAuthority(authority);
  const manifest: PluginManifest = { id: "fixture", publisher: "test", version: "0.2.0", host: "^1", contributes: { usage: {} }, tier: "free", reentrant: true,
    capabilities: [{ name: "fs.read", scopes: ["${HOME}/telemetry.json"] }, { name: "process.spawn", scopes: ["opencode"] }] };
  const provider = { id: manifest.id, manifest };
  try {
    const running = answerCapability(ctx, provider, "capability.process.spawn", { argv, timeoutMs: 1000 }, authority);
    await expect(answerCapability(ctx, provider, "capability.fs.read", { path }, authority)).rejects.toMatchObject({ code: "conflict" });
    await expect(answerCapability(ctx, provider, "capability.process.outputChunk", { handle: "unowned", offset: 0, length: 1 }, authority)).rejects.toMatchObject({ code: "conflict" });
    expect(await running).toHaveProperty("stdout", "done");
    expect(await answerCapability(ctx, provider, "capability.fs.read", { path }, authority)).toHaveProperty("text", "{}");
  } finally { await authority.revoke(); }
});
