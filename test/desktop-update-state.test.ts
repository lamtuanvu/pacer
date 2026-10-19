import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../src/core/errors";
import { readUpdate, writeUpdate } from "../src/update/desktop/store";
import { cancelRestart, checkDue, checksEnabled, rememberRequest, replayRequest, requestRestart, updateStatus } from "../src/update/desktop/policy";
import type { Installation, RestartRequest, UpdateRecord } from "../src/update/desktop/types";
import wire from "./fixtures/desktop-update/wire.json";
import { fakeCtx, tmpDir } from "./helpers";

const installation = wire.installation as Installation;
const ready = () => structuredClone(wire.record) as UpdateRecord;
const restart = (record: UpdateRecord, requestId = "restart-1"): RestartRequest => ({
  installationId: record.installationId, requestId, expectRevision: record.revision,
  version: "1.1.0", clientId: "desktop-client",
});
const directory = (home: string) => join(home, "desktop-updates");
const file = (home: string) => join(directory(home), "desktop-fixture.json");
function expectCode(fn: () => unknown, code: CoreError["code"]) {
  try { fn(); throw new Error("expected CoreError"); }
  catch (error) { expect(error).toBeInstanceOf(CoreError); expect((error as CoreError).code).toBe(code); }
}

test("missing state defaults to idle and automatic downloads without creating files", () => {
  const ctx = fakeCtx();
  expect(readUpdate(ctx, installation.id)).toMatchObject({ schema: 1, phase: "idle", revision: 0, autoDownload: true, requestHistory: [] });
  expect(existsSync(ctx.pacerHome)).toBe(false);
});

test("durable compare-and-swap advances once and rejects stale revisions without losing state", () => {
  const ctx = fakeCtx();
  const written = writeUpdate(ctx, ready(), 0);
  expect(written.revision).toBe(1);
  expectCode(() => writeUpdate(ctx, { ...ready(), autoDownload: false }, 0), "conflict");
  expect(readUpdate(ctx, installation.id)).toEqual(written);
  expect(statSync(file(ctx.pacerHome)).mode & 0o777).toBe(0o600);
  expect(statSync(directory(ctx.pacerHome)).mode & 0o777).toBe(0o700);
  expect(readdirSync(directory(ctx.pacerHome)).sort()).toEqual(["admission.sqlite", "desktop-fixture.json"]);
});

test("two actual processes competing at one revision have exactly one winner", async () => {
  const ctx = fakeCtx(), rendezvous = tmpDir(), gate = join(rendezvous, "go");
  writeUpdate(ctx, ready(), 0);
  const markers = [join(rendezvous, "a"), join(rendezvous, "b")];
  const children = markers.map(marker => Bun.spawn([process.execPath, "test/fixtures/desktop-update/state-worker.ts", ctx.pacerHome, gate, marker, "write"], { stdout: "pipe", stderr: "pipe" }));
  try {
    const deadline = Date.now() + 5000;
    while (!markers.every(existsSync) && Date.now() < deadline) await Bun.sleep(5);
    expect(markers.every(existsSync)).toBe(true);
    writeFileSync(gate, "go");
    const results = await Promise.all(children.map(async child => {
      const output = await new Response(child.stdout).text();
      expect(await new Response(child.stderr).text()).toBe("");
      expect(await child.exited).toBe(0);
      return JSON.parse(output);
    }));
    expect(results.filter(result => result.revision === 2)).toHaveLength(1);
    expect(results.filter(result => result.code === "conflict")).toHaveLength(1);
    expect(readUpdate(ctx, installation.id).revision).toBe(2);
  } finally { children.forEach(child => child.kill()); }
});

test("even an old lock is never stolen and blocked writes preserve the record", () => {
  const ctx = fakeCtx();
  writeUpdate(ctx, ready(), 0);
  const lock = join(directory(ctx.pacerHome), "desktop-fixture.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "other-owner" }), { mode: 0o600 });
  utimesSync(lock, 1, 1);
  expectCode(() => writeUpdate(ctx, { ...ready(), revision: 1 }, 1), "conflict");
  expect(readFileSync(lock, "utf8")).toContain("other-owner");
  expect(readUpdate(ctx, installation.id).revision).toBe(1);
});

test("unsafe identifiers and malformed persisted state fail closed with CoreError", () => {
  const ctx = fakeCtx();
  for (const id of ["", "../escape", "/tmp/escape", "a/b", ".", "a\\b", "a".repeat(129)]) {
    expectCode(() => readUpdate(ctx, id), "invalid_input");
    expectCode(() => writeUpdate(ctx, { ...ready(), installationId: id }, 0), "invalid_input");
  }
  writeUpdate(ctx, ready(), 0);
  const malformed: unknown[] = ["{", { ...ready(), schema: 2 }, { ...ready(), revision: -1 },
    { ...ready(), phase: "invented" }, { ...ready(), candidate: { version: "1.1.0" } },
    { ...ready(), installationId: "different" }, { ...ready(), downloadedBytes: -1 },
    { ...ready(), requestHistory: [{}] }];
  for (const value of malformed) {
    writeFileSync(file(ctx.pacerHome), typeof value === "string" ? value : JSON.stringify(value));
    expectCode(() => readUpdate(ctx, installation.id), "invalid_input");
    expectCode(() => writeUpdate(ctx, ready(), 0), "invalid_input");
  }
});

test("state directories and files cannot redirect reads or writes through symlinks", () => {
  const ctx = fakeCtx(), outside = tmpDir();
  mkdirSync(ctx.pacerHome);
  symlinkSync(outside, directory(ctx.pacerHome));
  expectCode(() => writeUpdate(ctx, ready(), 0), "not_allowed");
  expectCode(() => readUpdate(ctx, installation.id), "not_allowed");
  expect(readdirSync(outside)).toEqual([]);
  const other = fakeCtx();
  mkdirSync(directory(other.pacerHome), { recursive: true, mode: 0o700 });
  const target = join(outside, "state.json");
  writeFileSync(target, JSON.stringify(ready()));
  symlinkSync(target, file(other.pacerHome));
  expectCode(() => readUpdate(other, installation.id), "not_allowed");
  expectCode(() => writeUpdate(other, ready(), 0), "not_allowed");
  expect(JSON.parse(readFileSync(target, "utf8")).revision).toBe(0);
});

test("restart pins version, installation and revision, and requires a complete ready candidate", () => {
  const record = ready();
  for (const change of [{ version: "1.2.0" }, { expectRevision: 9 }, { installationId: "other" }]) {
    expectCode(() => requestRestart(record, { ...restart(record), ...change }, "boot-1"), "conflict");
  }
  for (const change of [{ phase: "downloading" as const }, { candidate: null }, { downloadedBytes: 100 }, { totalBytes: null }]) {
    expectCode(() => requestRestart({ ...record, ...change }, restart(record), "boot-1"), "conflict");
  }
  const waiting = requestRestart(record, restart(record), "boot-1");
  expect(waiting).toMatchObject({ phase: "waiting", requestedBy: "desktop-client", requesterBootId: "boot-1", requestId: "restart-1" });
  expect(waiting.transactionId).toBeTruthy();
  expect(record.phase).toBe("ready");
});

test("restart replays use one transaction across a fresh process, and changed action or payload conflicts", async () => {
  const ctx = fakeCtx(), request = restart(ready());
  const waiting = writeUpdate(ctx, requestRestart(ready(), request, "boot-1"), 0);
  const child = Bun.spawn([process.execPath, "test/fixtures/desktop-update/state-worker.ts", ctx.pacerHome, "unused", "unused", "read"], { stdout: "pipe", stderr: "pipe" });
  const restored = JSON.parse(await new Response(child.stdout).text()) as UpdateRecord;
  expect(await child.exited).toBe(0);
  expect(requestRestart(restored, request, "boot-1").transactionId).toBe(waiting.transactionId);
  expectCode(() => requestRestart(restored, { ...request, version: "1.2.0" }, "boot-1"), "conflict");
  expectCode(() => replayRequest(restored, request, "download"), "conflict");
  expectCode(() => requestRestart(restored, request, "boot-2"), "conflict");
});

test("cancellation revokes restart permission, keeps the candidate and rejects replay after persistence", () => {
  const ctx = fakeCtx(), request = restart(ready());
  const waiting = requestRestart(ready(), request, "boot-1");
  const cancelled = writeUpdate(ctx, cancelRestart(waiting), 0);
  expect(cancelled).toMatchObject({ phase: "ready", requestId: null, requestedBy: null, requesterBootId: null });
  expect(cancelled.candidate).toEqual(ready().candidate);
  expectCode(() => requestRestart(readUpdate(ctx, installation.id), request, "boot-1"), "conflict");
  expectCode(() => cancelRestart({ ...waiting, phase: "installing" }), "conflict");
  expect(cancelRestart(cancelled)).toEqual(cancelled);
});

test("generic action receipts preserve fingerprint and cannot be erased by subsequent writes", () => {
  const ctx = fakeCtx(), record = ready(), request = restart(record, "configure-1");
  const changed = rememberRequest({ ...record, autoDownload: false }, request, "configure", { autoDownload: false });
  const saved = writeUpdate(ctx, changed, 0);
  expect(replayRequest(readUpdate(ctx, installation.id), request, "configure", { autoDownload: false })).not.toBeNull();
  expectCode(() => replayRequest(saved, request, "configure", { autoDownload: true }), "conflict");
  expectCode(() => writeUpdate(ctx, { ...saved, requestHistory: [] }, saved.revision), "conflict");
});

test("status explicitly projects public fields and actions without exposing internal identity or receipts", () => {
  const status = updateStatus(installation, ready());
  expect(status).toMatchObject({ current: "1.0.0", target: "1.1.0", ownership: "managed", releaseNotes: "A new release." });
  expect(status.actions).toContain("restart");
  for (const key of ["candidate", "signature", "url", "sha256", "appPath", "pacerHome", "requestHistory", "requestedBy", "requesterBootId"]) {
    expect(Object.keys(status)).not.toContain(key);
  }
  const waiting = requestRestart(ready(), restart(ready()), "boot-1");
  expect(updateStatus(installation, waiting).actions).toEqual(["cancel"]);
  expect(updateStatus(installation, { ...waiting, phase: "installing" }).actions).toEqual([]);
  expect(updateStatus(installation, { ...waiting, phase: "recovery-failed" }).actions).toEqual([]);
  expect(updateStatus({ ...installation, ownership: "attached" }, ready()).actions).toContain("adopt");
});

test("checks use seconds at the exact 24-hour boundary and recover from a backwards clock", () => {
  expect(checkDue(null, 100)).toBe(true);
  expect(checkDue(100, 100 + 86399)).toBe(false);
  expect(checkDue(100, 100 + 86400)).toBe(true);
  expect(checkDue(100, 99)).toBe(true);
});

test("desktop check policy respects existing environment and active strategy opt-outs", () => {
  const ctx = fakeCtx();
  expect(checksEnabled(ctx)).toBe(true);
  expect(checksEnabled({ ...ctx, env: { PACER_NO_UPDATE_CHECK: "1" } })).toBe(false);
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "update_check: false\n");
  expect(checksEnabled(ctx)).toBe(false);
  mkdirSync(join(ctx.pacerHome, "strategies"));
  writeFileSync(join(ctx.pacerHome, "active"), "economy");
  writeFileSync(join(ctx.pacerHome, "strategies/economy.yaml"), "update_check: true\n");
  expect(checksEnabled(ctx)).toBe(true);
  writeFileSync(join(ctx.pacerHome, "strategies/economy.yaml"), "update_check: false\n");
  expect(checksEnabled(ctx)).toBe(false);
});


test("offered candidates expose manual download while only complete downloads expose restart", () => {
  const offered = { ...ready(), phase: "idle" as const, autoDownload: false, downloadedBytes: 0, totalBytes: null };
  expect(updateStatus(installation, offered).actions).toContain("download");
  expect(updateStatus(installation, offered).actions).not.toContain("restart");
  expect(updateStatus(installation, { ...ready(), downloadedBytes: 10 }).actions).not.toContain("restart");
});

test("persisted ready state and pending restart authority must be internally consistent", () => {
  const ctx = fakeCtx();
  writeUpdate(ctx, ready(), 0);
  const waiting = requestRestart(ready(), restart(ready()), "boot-1");
  for (const invalid of [
    { ...ready(), candidate: null }, { ...ready(), downloadedBytes: 1 },
    { ...waiting, requestedBy: null }, { ...waiting, transactionId: null },
    { ...waiting, requestHistory: [] },
  ]) {
    writeFileSync(file(ctx.pacerHome), JSON.stringify(invalid));
    expectCode(() => readUpdate(ctx, installation.id), "invalid_input");
  }
});

test("read-only contexts and non-private files or directories refuse persistence", () => {
  const ctx = fakeCtx();
  expectCode(() => writeUpdate({ ...ctx, readOnly: true }, ready(), 0), "not_allowed");
  expect(existsSync(ctx.pacerHome)).toBe(false);
  writeUpdate(ctx, ready(), 0);
  chmodSync(file(ctx.pacerHome), 0o644);
  expectCode(() => readUpdate(ctx, installation.id), "not_allowed");
  expectCode(() => writeUpdate(ctx, { ...ready(), revision: 1 }, 1), "not_allowed");
  chmodSync(file(ctx.pacerHome), 0o600);
  chmodSync(directory(ctx.pacerHome), 0o755);
  expectCode(() => writeUpdate(ctx, { ...ready(), revision: 1 }, 1), "not_allowed");
});

for (const phase of ["reserved", "installing", "verifying", "rolling-back"] as const) {
  test(`${phase} rejects persisted state missing its candidate or retained restart authority`, () => {
    const ctx = fakeCtx();
    writeUpdate(ctx, ready(), 0);
    const authorized = { ...requestRestart(ready(), restart(ready()), "boot-1"), phase };
    const receipt = authorized.requestHistory[0]!;
    for (const invalid of [
      { ...ready(), phase },
      { ...authorized, candidate: null },
      { ...authorized, downloadedBytes: 1 },
      { ...authorized, totalBytes: null },
      { ...authorized, transactionId: null },
      { ...authorized, requestId: null },
      { ...authorized, requestedBy: null },
      { ...authorized, requesterBootId: null },
      { ...authorized, requestHistory: [] },
      { ...authorized, requestHistory: [{ ...receipt, requestId: "another-request" }] },
      { ...authorized, requestHistory: [{ ...receipt, action: "check" }] },
      { ...authorized, requestHistory: [{ ...receipt, transactionId: "another-transaction" }] },
    ]) {
      writeFileSync(file(ctx.pacerHome), JSON.stringify(invalid));
      expectCode(() => readUpdate(ctx, installation.id), "invalid_input");
    }
  });

  test(`${phase} retains authorized state for recovery without requiring a live initiating desktop`, () => {
    const ctx = fakeCtx();
    const authorized = { ...requestRestart(ready(), restart(ready()), "previous-boot"), phase };
    const written = writeUpdate(ctx, authorized, 0);
    expect(readUpdate(ctx, installation.id)).toEqual(written);
    expect(written).toMatchObject({
      phase, requestedBy: "desktop-client", requesterBootId: "previous-boot",
      requestHistory: [{ requestId: "restart-1", action: "restart", transactionId: written.transactionId }],
    });
  });
}

test("terminal error and recovery records preserve diagnostics without requiring active restart intent", () => {
  for (const phase of ["restored", "error", "recovery-failed"] as const) {
    const ctx = fakeCtx();
    const record = {
      ...readUpdate(ctx, installation.id), phase, failedVersion: "1.1.0",
      error: { code: "verification_failed", message: "Retain the recovery materials for diagnosis." },
    };
    writeUpdate(ctx, record, record.revision);
    expect(readUpdate(ctx, installation.id)).toMatchObject({
      phase, transactionId: null, requestedBy: null, failedVersion: "1.1.0", error: record.error,
    });
  }
});

for (const phase of ["waiting", "reserved", "installing", "verifying", "rolling-back"] as const) {
  test(`${phase} rejects candidate version or requester substitution against the persisted receipt`, () => {
    const ctx = fakeCtx();
    const authorized = { ...requestRestart(ready(), restart(ready()), "boot-1"), phase };
    writeUpdate(ctx, authorized, 0);
    const persisted = readUpdate(ctx, installation.id);
    for (const changed of [
      { ...persisted, candidate: { ...persisted.candidate!, version: "1.2.0" } },
      { ...persisted, requestedBy: "another-client" },
    ]) {
      writeFileSync(file(ctx.pacerHome), JSON.stringify(persisted));
      expectCode(() => writeUpdate(ctx, changed, persisted.revision), "invalid_input");
      writeFileSync(file(ctx.pacerHome), JSON.stringify(changed));
      expectCode(() => readUpdate(ctx, installation.id), "invalid_input");
    }
  });
}
