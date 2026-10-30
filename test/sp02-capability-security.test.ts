import { expect, test } from "bun:test";
import { mkdirSync, renameSync, symlinkSync, writeFileSync, utimesSync, truncateSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { answerFilesystem, prepareFilesystemAuthority } from "../src/plugins/capability-fs";
import { CoreError } from "../src/core/errors";
function answerCapability(_ctx: unknown, plugin: typeof provider, method: string, params: Record<string, unknown>, authority?: ReturnType<typeof createCallAuthority>): Promise<unknown> {
  if (!authority) return Promise.reject(new CoreError("capability_denied", "missing owning call"));
  return answerFilesystem(authority, plugin.manifest.capabilities[0].scopes, method, params);
}
import { createCallAuthority } from "../src/plugins/authority";
import type { PluginManifest } from "../src/plugins/protocol";
import { fakeCtx } from "./helpers";

const provider = { id: "sp02-security", manifest: { id: "sp02-security", version: "0.2.0", publisher: "test", host: "^1.6",
  contributes: { usage: {} }, capabilities: [{ name: "fs.read", scopes: ["$ACCOUNT_HOME/sessions/**"] }],
  reentrant: true, tier: "free" } satisfies PluginManifest };
async function resources() {
  const ctx = fakeCtx(), accountHome = join(ctx.home, "account-a"), otherHome = join(ctx.home, "account-b");
  const sessions = join(accountHome, "sessions"), otherSessions = join(otherHome, "sessions");
  mkdirSync(sessions, { recursive: true }); mkdirSync(otherSessions, { recursive: true });
  const allowed = join(sessions, "rollout-allowed.jsonl"), foreign = join(otherSessions, "rollout-private.jsonl");
  writeFileSync(allowed, "aλz\n"); writeFileSync(foreign, "other-account-private-observation");
  writeFileSync(join(accountHome, "auth.json"), "synthetic-native-credential");
  writeFileSync(join(sessions, "auth.json"), "synthetic-disguised-credential");
  const grant = { reads: [{ path: sessions, kind: "codex-logs" as const }], commands: [], stores: [] };
  const authority = createCallAuthority(ctx, grant, { deadlineMs: Date.now() + 10000, grants: ["fs.read"], accountHome });
  await prepareFilesystemAuthority(authority);
  return { ctx, accountHome, otherHome, sessions, otherSessions, allowed, foreign, grant, authority };
}
async function denied(operation: Promise<unknown>) {
  await expect(operation).rejects.toMatchObject({ code: "capability_denied" });
}

test("host-issued read authority permits its log but refuses absent, revoked and expired authority", async () => {
  const f = await resources();
  const call = (authority = f.authority) => answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }, authority);
  try {
    expect(await call()).toMatchObject({ text: "aλz\n" });
    await denied(answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }));
    await f.authority.revoke();
    await denied(call());
    const expired = createCallAuthority(f.ctx, f.grant, { deadlineMs: Date.now() - 1, grants: ["fs.read"], accountHome: f.accountHome });
    try { await denied(call(expired)); } finally { await expired.revoke(); }
  } finally { await f.authority.revoke(); }
});

test("captured grants and account paths cannot be broadened by mutating issuer inputs", async () => {
  const f = await resources(), grants: string[] = [];
  const immutable = createCallAuthority(f.ctx, f.grant, { deadlineMs: Date.now() + 10000, grants, accountHome: f.accountHome });
  try {
    grants.push("fs.read");
    await denied(answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }, immutable));
    f.grant.reads.push({ path: f.otherSessions, kind: "codex-logs" });
    await denied(answerCapability(f.ctx, provider, "capability.fs.read", { path: f.foreign }, f.authority));
    expect(f.authority.token).not.toBe(immutable.token);
  } finally { await Promise.all([immutable.revoke(), f.authority.revoke()]); }
});

test("account scopes refuse credentials, sibling paths, traversal, and symlink escapes", async () => {
  const f = await resources();
  const finalLink = join(f.sessions, "rollout-link.jsonl");
  const directoryLink = join(f.sessions, "escaped");
  symlinkSync(f.foreign, finalLink); symlinkSync(f.otherSessions, directoryLink, "dir");
  try {
    for (const path of [f.foreign, join(f.accountHome, "auth.json"), join(f.sessions, "auth.json"),
      f.sessions + "/../../account-b/sessions/rollout-private.jsonl", finalLink, join(directoryLink, "rollout-private.jsonl")]) {
      await denied(answerCapability(f.ctx, provider, "capability.fs.read", { path }, f.authority));
    }
    const listed = await answerCapability(f.ctx, provider, "capability.fs.list", { dir: f.sessions, glob: "**/rollout-*.jsonl", limit: 15 }, f.authority) as { files: { path: string }[] };
    expect(listed.files.map(file => file.path)).toEqual([f.allowed]);
  } finally { await f.authority.revoke(); }
});

test("range bytes preserve split UTF-8 and refuse a rotated inode before returning data", async () => {
  const f = await resources();
  try {
    const { info } = await answerCapability(f.ctx, provider, "capability.fs.stat", { path: f.allowed }, f.authority) as { info: any };
    const range = await answerCapability(f.ctx, provider, "capability.fs.readRange", { path: f.allowed, offset: 2, length: 1,
      expected: { size: info.size, mtimeMs: info.mtimeMs, inode: info.inode, device: info.device } }, f.authority) as { base64: string };
    expect(Buffer.from(range.base64, "base64")).toEqual(Buffer.from("aλz\n").subarray(2, 3));
    renameSync(f.allowed, f.allowed + ".old"); writeFileSync(f.allowed, "aλz\n");
    await expect(answerCapability(f.ctx, provider, "capability.fs.readRange", { path: f.allowed, offset: 0, length: 1,
      expected: { size: info.size, mtimeMs: info.mtimeMs, inode: info.inode, device: info.device } }, f.authority))
      .rejects.toMatchObject({ code: "conflict" });
  } finally { await f.authority.revoke(); }
});

test("aborting a parent prevents late reads and its successor does not reactivate the old authority", async () => {
  const f = await resources(), parent = new AbortController();
  const old = createCallAuthority(f.ctx, f.grant, { deadlineMs: Date.now() + 10000, signal: parent.signal, grants: ["fs.read"], accountHome: f.accountHome });
  await prepareFilesystemAuthority(old);
  try {
    expect(await answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }, old)).toMatchObject({ text: "aλz\n" });
    parent.abort(); await old.revoke();
    expect(old.signal.aborted).toBe(true);
    expect(await answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }, f.authority)).toMatchObject({ text: "aλz\n" });
    await denied(answerCapability(f.ctx, provider, "capability.fs.read", { path: f.allowed }, old));
  } finally { await Promise.all([old.revoke(), f.authority.revoke()]); }
});


test("granted root stat is metadata only, and missing bytes do not disclose an ungranted path", async () => {
  const f = await resources();
  try {
    expect(await answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.stat", { path: f.sessions }))
      .toMatchObject({ info: { path: f.sessions } });
    await denied(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.read", { path: f.sessions }));
    expect(await answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.read", { path: join(f.sessions, "rollout-missing.jsonl") }))
      .toEqual({ missing: true });
    await denied(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.read", { path: join(f.otherSessions, "rollout-missing.jsonl") }));
    await denied(answerFilesystem(f.authority, ["$UNSET_RESOURCE/**"], "capability.fs.read", { path: f.allowed }));
  } finally { await f.authority.revoke(); }
});

test("bounded listing selects a late newest rollout after more than one thousand matches", async () => {
  const f = await resources();
  for (let index = 0; index < 1002; index++) {
    const path = join(f.sessions, `rollout-${index}.jsonl`);
    writeFileSync(path, "{}\n"); utimesSync(path, 1000 + index, 1000 + index);
  }
  const late = join(f.sessions, "rollout-zz-newest.jsonl"), now = Date.now() / 1000 + 100;
  writeFileSync(late, "{}\n"); utimesSync(late, now, now);
  try {
    const result = await answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.list", {
      dir: f.sessions, glob: "**/rollout-*.jsonl", limit: 15,
    }) as { files: { path: string }[]; complete: boolean };
    expect(result.files).toHaveLength(15); expect(result.complete).toBe(false);
    expect(result.files[0].path).toBe(late);
    await expect(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.list", {
      dir: f.sessions, glob: "**/rollout-*.jsonl", limit: 1001,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.list", {
      dir: f.sessions, glob: "../**", limit: 15,
    })).rejects.toMatchObject({ code: "invalid_input" });
  } finally { await f.authority.revoke(); }
}, 10000);

test("large or heavily escaped reads require bounded ranges, and stale size never yields partial bytes", async () => {
  const f = await resources();
  writeFileSync(f.allowed, Buffer.alloc(200000));
  try {
    const result = await answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.read", { path: f.allowed }) as { ranged: any };
    expect(result).toMatchObject({ ranged: { size: 200000 } });
    const expected = result.ranged;
    await expect(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.readRange", {
      path: f.allowed, offset: 0, length: 262145, expected,
    })).rejects.toMatchObject({ code: "invalid_input" });
    const bytes = await answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.readRange", {
      path: f.allowed, offset: 0, length: 10, expected,
    }) as { base64: string };
    expect(Buffer.from(bytes.base64, "base64")).toEqual(Buffer.alloc(10));
    truncateSync(f.allowed, 3);
    await expect(answerFilesystem(f.authority, provider.manifest.capabilities[0].scopes, "capability.fs.readRange", {
      path: f.allowed, offset: 0, length: 10, expected,
    })).rejects.toMatchObject({ code: "conflict" });
  } finally { await f.authority.revoke(); }
});

test("one owning call has one filesystem window and revoke waits its operation", async () => {
  const f = await resources();
  const running = answerFilesystem(f.authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed });
  const observed = running.then(value => ({ value, error: null }), error => ({ value: null, error }));
  await denied(answerFilesystem(f.authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }));
  await f.authority.revoke();
  expect((await observed).error).toMatchObject({ code: "capability_denied" });
});

test("a first-RPC account root swap cannot redirect issued authority to another account", async () => {
  const f = await resources();
  writeFileSync(join(f.otherSessions, "rollout-allowed.jsonl"), "other-account-private");
  renameSync(f.accountHome, f.accountHome + ".original");
  symlinkSync(f.otherHome, f.accountHome, "dir");
  try { await denied(answerFilesystem(f.authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed })); }
  finally { await f.authority.revoke(); }
});

test("configured canonical aliases work, but replacing their target after issuance is denied", async () => {
  const f = await resources(); await f.authority.revoke();
  renameSync(f.accountHome, f.accountHome + ".configured"); symlinkSync(f.accountHome + ".configured", f.accountHome, "dir");
  const authority = createCallAuthority(f.ctx, f.grant, { deadlineMs: Date.now() + 10000, grants: ["fs.read"], accountHome: f.accountHome });
  await prepareFilesystemAuthority(authority);
  try {
    expect(await answerFilesystem(authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed })).toMatchObject({ text: "aλz\n" });
    writeFileSync(join(f.otherSessions, "rollout-allowed.jsonl"), "other-account-private");
    unlinkSync(f.accountHome); symlinkSync(f.otherHome, f.accountHome, "dir");
    await denied(answerFilesystem(authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }));
  } finally { await authority.revoke(); }
});

test("filesystem preparation is mandatory and cannot repin a replaced directory", async () => {
  const f = await resources();
  const unprepared = createCallAuthority(f.ctx, f.grant, { deadlineMs: Date.now() + 10000, grants: ["fs.read"], accountHome: f.accountHome });
  try {
    await denied(answerFilesystem(unprepared, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }));
    renameSync(f.sessions, f.sessions + ".old"); mkdirSync(f.sessions);
    writeFileSync(f.allowed, "replacement-directory");
    await prepareFilesystemAuthority(f.authority);
    await denied(answerFilesystem(f.authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }));
  } finally { await f.authority.revoke(); await unprepared.revoke(); }
});

test("exact-file resources preserve selected cache reads without granting neighboring files", async () => {
  const f = await resources(), selected = join(f.ctx.home, "claude-budget.json"), sibling = join(f.ctx.home, "auth.json");
  writeFileSync(selected, '{"remaining":5}'); writeFileSync(sibling, "synthetic-credential");
  const authority = createCallAuthority(f.ctx, { reads: [{ path: selected, kind: "file" }], commands: [], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["fs.read"] });
  await prepareFilesystemAuthority(authority);
  try {
    expect(await answerFilesystem(authority, ["$HOME/claude-budget.json"], "capability.fs.read", { path: selected })).toMatchObject({ text: '{"remaining":5}' });
    await denied(answerFilesystem(authority, ["$HOME/**"], "capability.fs.read", { path: sibling }));
    await denied(answerFilesystem(authority, ["$HOME/**"], "capability.fs.list", { dir: f.ctx.home, glob: "*" }));
  } finally { await authority.revoke(); await f.authority.revoke(); }
});

test("concurrent account authorities keep distinct paths and neither inherits its neighbor", async () => {
  const f = await resources();
  const other = createCallAuthority(f.ctx, { reads: [{ path: f.otherSessions, kind: "codex-logs" }], commands: [], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["fs.read"], accountHome: f.otherHome });
  await prepareFilesystemAuthority(other);
  try {
    const [a, b] = await Promise.all([
      answerFilesystem(f.authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }),
      answerFilesystem(other, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.foreign }),
    ]);
    expect(a).toMatchObject({ text: "aλz\n" }); expect(b).toMatchObject({ text: "other-account-private-observation" });
    await denied(answerFilesystem(other, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path: f.allowed }));
  } finally { await other.revoke(); await f.authority.revoke(); }
});

test("a root missing at issuance cannot be silently rebound after later creation", async () => {
  const f = await resources(), missing = join(f.ctx.home, "not-yet-created", "sessions");
  const authority = createCallAuthority(f.ctx, { reads: [{ path: missing, kind: "codex-logs" }], commands: [], stores: [] },
    { deadlineMs: Date.now() + 10000, grants: ["fs.read"], accountHome: join(f.ctx.home, "not-yet-created") });
  await prepareFilesystemAuthority(authority); mkdirSync(missing, { recursive: true });
  const path = join(missing, "rollout-created.jsonl"); writeFileSync(path, "new-root-content");
  try { expect(await answerFilesystem(authority, ["$ACCOUNT_HOME/sessions/**"], "capability.fs.read", { path })).toEqual({ missing: true }); }
  finally { await authority.revoke(); await f.authority.revoke(); }
});
