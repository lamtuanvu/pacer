import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { issueBundleStageResource, prepareBundleStageAuthority, stageBundle, resolveStagedBundle, publishStagedBundle,
  transferStagedBundleOwnership, resolveTransferredBundle, discardTransferredBundle } from "../src/plugins/bundle-stage";
import { answerCapability } from "../src/plugins/host";
import { manifestSchema } from "../src/plugins/protocol";
import { fakeCtx, tmpDir } from "./helpers";

const owners: CallAuthority[] = [];
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.revoke())); });

function fixture(body: string | ((home: string) => string) = "printf '__PACER_BEGIN__\\nabc'", maxBytes = 16, timeoutMs = 1000) {
  const home = tmpDir(), pacerHome = join(home, ".pacer"), executable = join(home, "ssh");
  mkdirSync(pacerHome, { recursive: true });
  writeFileSync(join(pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  writeFileSync(executable, `#!/bin/sh\n${typeof body === "function" ? body(home) : body}\n`); chmodSync(executable, 0o700);
  const ctx = fakeCtx({ home, pacerHome, which: name => name === "ssh" ? executable : null });
  const issued = issueBundleStageResource(ctx, "box", ["~/worktree", "a".repeat(40), "pacer/task"], maxBytes, timeoutMs);
  const owner = createCallAuthority(ctx, { reads: [], commands: [], stores: [], bundleStages: [issued] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  owners.push(owner);
  prepareBundleStageAuthority(owner);
  return { ctx, owner, issued, executable };
}

test("host issues one exact BUNDLE_OUT argv and denies changed request before spawn", async () => {
  const f = fixture();
  expect(f.issued.argv.join(" ")).toContain("ssh-fixture");
  for (const bad of [
    { argv: [...f.issued.argv, "extra"], timeoutMs: 1000, maxBytes: 16 },
    { argv: f.issued.argv, timeoutMs: 1001, maxBytes: 16 },
    { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 17 },
  ]) await expect(stageBundle(f.owner, bad)).rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(join(f.ctx.pacerHome, "transfers"))).toBe(false);
  const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  expect(result).toMatchObject({ bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  expect(readFileSync(resolveStagedBundle(f.owner, result.handle).path).toString()).toBe("abc");
  await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
    .rejects.toMatchObject({ code: "capability_denied" });
  const published = publishStagedBundle(f.owner, result.handle);
  expect(published.name).toBe(`${result.sha256}.bundle`);
  expect(readFileSync(join(f.ctx.pacerHome, "transfers", published.name)).toString()).toBe("abc");
  expect(readdirSync(join(f.ctx.pacerHome, "transfers")).sort()).toEqual([published.name]);
  await f.owner.revoke();
  expect(readFileSync(join(f.ctx.pacerHome, "transfers", published.name)).toString()).toBe("abc");
});

test("plugin can stage binary only through its scoped process capability", async () => {
  const f = fixture();
  const plugin = { id: "fx-ssh", manifest: manifestSchema.parse({ id: "fx-ssh", version: "1.0.0", publisher: "test", host: "^1.7",
    contributes: {}, capabilities: [{ name: "process.spawn", scopes: ["ssh"] }], reentrant: true, tier: "free" }) };
  await expect(answerCapability(f.ctx, plugin, "capability.process.stageBundle",
    { argv: [...f.issued.argv, "unexpected"], timeoutMs: 1000, maxBytes: 16 }, f.owner))
    .rejects.toMatchObject({ code: "capability_denied" });
  const result = await answerCapability(f.ctx, plugin, "capability.process.stageBundle",
    { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }, f.owner) as { handle: string; bytes: number; sha256: string };
  expect(result.bytes).toBe(3);
  expect(readFileSync(resolveStagedBundle(f.owner, result.handle).path).toString()).toBe("abc");
});

test("bundle staging does not broaden a plugin's declared process scope", async () => {
  const f = fixture();
  const plugin = { id: "fx-other", manifest: manifestSchema.parse({ id: "fx-other", version: "1.0.0", publisher: "test", host: "^1.7",
    contributes: {}, capabilities: [{ name: "process.spawn", scopes: ["git"] }] }) };
  await expect(answerCapability(f.ctx, plugin, "capability.process.stageBundle",
    { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }, f.owner))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(join(f.ctx.pacerHome, "transfers"))).toBe(false);
});

test("bundle issuer rejects non-BUNDLE_OUT run identities and changed host or executable", async () => {
  const f = fixture();
  await expect(() => issueBundleStageResource(f.ctx, "box", ["~/worktree", "bad", "pacer/task"]))
    .toThrow();
  await expect(() => issueBundleStageResource(f.ctx, "box", ["~/worktree", "a".repeat(40), "other/task"]))
    .toThrow();
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: changed-host\n");
  await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(join(f.ctx.pacerHome, "transfers"))).toBe(false);
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  writeFileSync(f.executable, "#!/bin/sh\nprintf 'changed'\n");
  await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(existsSync(join(f.ctx.pacerHome, "transfers"))).toBe(false);
});

test("staged bundle handles belong to one authority and unclaimed bytes vanish on revoke", async () => {
  const f = fixture();
  const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const other = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [], bundleStages: [f.issued] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  owners.push(other); prepareBundleStageAuthority(other);
  expect(() => resolveStagedBundle(other, result.handle)).toThrow();
  const stagePath = resolveStagedBundle(f.owner, result.handle).path;
  await f.owner.revoke();
  expect(existsSync(stagePath)).toBe(false);
  expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
});

test("host-private transfer binds a one-use ticket to one caller and survives provider revoke", async () => {
  const f = fixture();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const foreign = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller, foreign);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const stagePath = resolveStagedBundle(f.owner, staged.handle).path;
  const ticket = transferStagedBundleOwnership(f.owner, staged.handle, caller);
  expect(() => resolveStagedBundle(f.owner, staged.handle)).toThrow();
  expect(() => resolveTransferredBundle(foreign, ticket)).toThrow();
  expect(() => resolveTransferredBundle(caller, structuredClone(ticket))).toThrow();
  await f.owner.revoke();
  expect(existsSync(stagePath)).toBe(true);
  expect(readdirSync(join(f.ctx.pacerHome, "transfers")).every(name => !name.endsWith(".bundle"))).toBe(true);
  expect(readFileSync(resolveTransferredBundle(caller, ticket).path).toString()).toBe("abc");
  expect(() => resolveTransferredBundle(caller, ticket)).toThrow();
  await caller.revoke();
  expect(existsSync(stagePath)).toBe(false);
});

test("transfer refuses a retired or unrelated caller and leaves provider cleanup intact", async () => {
  const f = fixture();
  const unrelated = createCallAuthority(fakeCtx(), { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const retired = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(unrelated, retired);
  await retired.revoke();
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const stagePath = resolveStagedBundle(f.owner, staged.handle).path;
  expect(() => transferStagedBundleOwnership(f.owner, staged.handle, unrelated)).toThrow();
  expect(() => transferStagedBundleOwnership(f.owner, staged.handle, retired)).toThrow();
  await f.owner.revoke();
  expect(existsSync(stagePath)).toBe(false);
});

test("caller cancellation cleans a transferred stage without a public bundle", async () => {
  const f = fixture();
  const cancel = new AbortController();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, signal: cancel.signal, grants: ["hosts"] });
  owners.push(caller);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const path = resolveStagedBundle(f.owner, staged.handle).path;
  const ticket = transferStagedBundleOwnership(f.owner, staged.handle, caller);
  cancel.abort();
  await caller.revoke();
  expect(existsSync(path)).toBe(false);
  expect(() => resolveTransferredBundle(caller, ticket)).toThrow();
  expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
});

test("transferred stage tampering fails closed at use and removes private bytes", async () => {
  const f = fixture();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const path = resolveStagedBundle(f.owner, staged.handle).path;
  const ticket = transferStagedBundleOwnership(f.owner, staged.handle, caller);
  writeFileSync(path, "xyz");
  expect(() => resolveTransferredBundle(caller, ticket)).toThrow();
  expect(existsSync(path)).toBe(false);
  expect(() => resolveTransferredBundle(caller, ticket)).toThrow();
  await caller.revoke();
});

test("transfer rejects tampered bytes before changing the provider owner", async () => {
  const f = fixture();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const path = resolveStagedBundle(f.owner, staged.handle).path;
  writeFileSync(path, "xyz");
  expect(() => transferStagedBundleOwnership(f.owner, staged.handle, caller)).toThrow();
  await f.owner.revoke();
  expect(existsSync(path)).toBe(false);
});

test("caller revoke surfaces transferred-stage cleanup uncertainty", async () => {
  const f = fixture();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const path = resolveStagedBundle(f.owner, staged.handle).path;
  transferStagedBundleOwnership(f.owner, staged.handle, caller);
  const stageDir = dirname(path);
  chmodSync(stageDir, 0o000);
  try {
    await expect(caller.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
  } finally {
    chmodSync(stageDir, 0o700);
    rmSync(stageDir, { recursive: true, force: true });
  }
});

test("host discard removes only the exact caller's claimed ticket", async () => {
  const f = fixture();
  const caller = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const foreign = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller, foreign);
  const staged = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const path = resolveStagedBundle(f.owner, staged.handle).path;
  const ticket = transferStagedBundleOwnership(f.owner, staged.handle, caller);
  expect(() => discardTransferredBundle(foreign, ticket)).toThrow();
  expect(existsSync(path)).toBe(true);
  discardTransferredBundle(caller, ticket);
  expect(existsSync(path)).toBe(false);
  discardTransferredBundle(caller, ticket);
  expect(() => resolveTransferredBundle(caller, ticket)).toThrow();
});

test("bundle stage preserves raw non-UTF-8 bytes after the payload marker", async () => {
  const f = fixture("printf '__PACER_BEGIN__\\n\\377\\000A'");
  const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  expect(readFileSync(resolveStagedBundle(f.owner, result.handle).path)).toEqual(Buffer.from([255, 0, 65]));
  expect(result.bytes).toBe(3);
});

test("host refuses a substituted staged path before atomic publication", async () => {
  const f = fixture();
  const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const stage = resolveStagedBundle(f.owner, result.handle);
  unlinkSync(stage.path); symlinkSync(f.executable, stage.path);
  expect(() => publishStagedBundle(f.owner, result.handle)).toThrow();
  expect(readdirSync(join(f.ctx.pacerHome, "transfers")).some(name => name.endsWith(".bundle"))).toBe(false);
});

test("bundle stdout and stderr overflow remove private partial stages", async () => {
  for (const body of [
    "printf '__PACER_BEGIN__\\n12345678901234567'",
    "head -c 65537 /dev/zero >&2; printf '__PACER_BEGIN__\\nabc'",
  ]) {
    const f = fixture(body);
    await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: "too_large" });
    expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
  }
});

test("missing frame, nonzero exit and owner cancellation never publish a bundle", async () => {
  for (const body of ["printf 'abc'", "printf '__PACER_BEGIN__\\nabc'; exit 7"]) {
    const f = fixture(body);
    await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
      .rejects.toMatchObject({ code: "plugin_refused" });
    expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
  }
  const f = fixture("printf '__PACER_BEGIN__\\n'; sleep 5; printf abc");
  const pending = stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const until = Date.now() + 1000;
  while (!existsSync(join(f.ctx.pacerHome, "transfers")) && Date.now() < until) await Bun.sleep(10);
  await f.owner.revoke();
  await expect(pending).rejects.toBeDefined();
  expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
});

test("owner revoke does not signal the same bundle process group twice before exit", async () => {
  const f = fixture(home => `printf '__PACER_BEGIN__\\n'; touch '${join(home, "started")}'; sleep 5`);
  const pending = stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const settled = pending.then(() => false, () => true);
  const until = Date.now() + 1000;
  while (!existsSync(join(f.ctx.home, "started")) && Date.now() < until) await Bun.sleep(10);
  expect(existsSync(join(f.ctx.home, "started"))).toBe(true);
  const originalKill = process.kill;
  let groupSignals = 0;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal === "SIGKILL" && ++groupSignals > 1)
      throw Object.assign(new Error("group already signaled"), { code: "EPERM" });
    return originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    await f.owner.revoke();
    expect(groupSignals).toBe(1);
    expect(await settled).toBe(true);
    expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
  } finally { process.kill = originalKill; }
});

test("failed first bundle group signal retains cleanup uncertainty", async () => {
  const f = fixture(home => `printf '__PACER_BEGIN__\\n'; touch '${join(home, "started")}'; sleep 5`);
  const pending = stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const settled = pending.then(() => false, () => true);
  const until = Date.now() + 1000;
  while (!existsSync(join(f.ctx.home, "started")) && Date.now() < until) await Bun.sleep(10);
  expect(existsSync(join(f.ctx.home, "started"))).toBe(true);
  const originalKill = process.kill;
  let groupSignals = 0;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal === "SIGKILL" && ++groupSignals === 1)
      throw Object.assign(new Error("group signal refused"), { code: "EPERM" });
    return originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    await expect(f.owner.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
    expect(groupSignals).toBeGreaterThanOrEqual(1);
    expect(await settled).toBe(true);
    expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
  } finally { process.kill = originalKill; }
});

test("host generation change cancels an in-flight binary stage promptly", async () => {
  const f = fixture("printf '__PACER_BEGIN__\\n'; sleep 5; printf abc");
  const pending = stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  const until = Date.now() + 1000;
  while (!existsSync(join(f.ctx.pacerHome, "transfers")) && Date.now() < until) await Bun.sleep(10);
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: changed-host\n");
  const settled = await Promise.race([pending.then(() => "success", () => "denied"), Bun.sleep(500).then(() => "late")]);
  expect(settled).toBe("denied");
  try { await f.owner.revoke(); }
  catch (error) {
    expect(error).toMatchObject({ code: "plugin_unavailable", message: "bundle descendant retained output pipes; cleanup unverified" });
  }
  expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
});

test("bundle SSH child receives only the host call environment", async () => {
  const key = "PACER_STAGE_AMBIENT_ONLY_TEST";
  const previous = process.env[key];
  process.env[key] = "ambient-secret";
  try {
    const f = fixture("printf '__PACER_BEGIN__\\n%s|%s' \"$PACER_STAGE_ALLOWED_TEST\" \"$PACER_STAGE_AMBIENT_ONLY_TEST\"");
    f.ctx.env.PACER_STAGE_ALLOWED_TEST = "host-value";
    const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
    expect(readFileSync(resolveStagedBundle(f.owner, result.handle).path).toString()).toBe("host-value|");
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});

test("an exited leader with retained pipes settles promptly and fails closed", async () => {
  const f = fixture("printf '__PACER_BEGIN__\\nabc'; sleep 2 & exit 0");
  const started = Date.now();
  await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(Date.now() - started).toBeLessThan(750);
  expect(readdirSync(join(f.ctx.pacerHome, "transfers"))).toEqual([]);
  await expect(stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 }))
    .rejects.toMatchObject({ code: "plugin_unavailable" });
  await expect(f.owner.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
});

test("a full-size 50 MiB bundle drains successfully after the leader exits", async () => {
  const bytes = 50 * 1024 * 1024;
  const f = fixture("printf '__PACER_BEGIN__\\n'; head -c 52428800 /dev/zero", bytes, 10_000);
  const result = await stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 10_000, maxBytes: bytes });
  expect(result.bytes).toBe(bytes);
  expect(statSync(resolveStagedBundle(f.owner, result.handle).path).size).toBe(bytes);
  await f.owner.revoke();
});

test("revoke after leader exit never signals its retired numeric PID", async () => {
  const f = fixture(home => `printf '%s' $$ > '${join(home, "leader.pid")}'; printf '__PACER_BEGIN__\\nabc'; sleep 2 & exit 0`);
  const pending = stageBundle(f.owner, { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 });
  void pending.catch(() => {});
  const pidFile = join(f.ctx.home, "leader.pid");
  const originalKill = process.kill;
  const until = Date.now() + 500;
  while (!existsSync(pidFile) && Date.now() < until) await Bun.sleep(5);
  const retiredPid = Number(readFileSync(pidFile, "utf8"));
  while (Date.now() < until) {
    try { originalKill(retiredPid, 0); } catch { break; }
    await Bun.sleep(5);
  }
  const signals: number[] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (Math.abs(pid) === retiredPid) { signals.push(pid); return true; }
    return originalKill(pid, signal);
  }) as typeof process.kill;
  try {
    await expect(f.owner.revoke()).rejects.toMatchObject({ code: "plugin_unavailable" });
    await expect(pending).rejects.toMatchObject({ code: "capability_denied" });
    expect(signals).toEqual([]);
  } finally { process.kill = originalKill; }
});

test("revoke attempts later stage cleanup after one directory cannot be removed", async () => {
  const f = fixture();
  const owner = createCallAuthority(f.ctx, { reads: [], commands: [], stores: [], bundleStages: [f.issued, f.issued] },
    { deadlineMs: Date.now() + 5000, grants: ["process.spawn"] });
  owners.push(owner); prepareBundleStageAuthority(owner);
  const request = { argv: f.issued.argv, timeoutMs: 1000, maxBytes: 16 };
  const first = resolveStagedBundle(owner, (await stageBundle(owner, request)).handle);
  const second = resolveStagedBundle(owner, (await stageBundle(owner, request)).handle);
  const firstDir = dirname(first.path);
  chmodSync(firstDir, 0o000);
  try {
    await expect(owner.revoke()).rejects.toBeDefined();
    expect(existsSync(second.path)).toBe(false);
  } finally {
    chmodSync(firstDir, 0o700);
    rmSync(firstDir, { recursive: true, force: true });
  }
});
