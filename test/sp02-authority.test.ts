import { expect, test } from "bun:test";
import { createCallAuthority } from "../src/plugins/authority";
import { fakeCtx } from "./helpers";

const empty = { reads: [], commands: [], stores: [] };
test("call authority expires against its original absolute deadline", async () => {
  const authority = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() - 1 });
  expect(() => authority.assertActive()).toThrow("expired");
  await authority.revoke();
  expect(authority.signal.aborted).toBe(true);
});

test("revocation rejects late work immediately but awaits owned cleanup", async () => {
  const authority = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let clean = false;
  authority.onRevoke(async () => { await held; clean = true; });
  const revoked = authority.revoke();
  expect(() => authority.assertActive()).toThrow("expired");
  expect(clean).toBe(false);
  release(); await revoked;
  expect(clean).toBe(true);
});

test("each call snapshots its resources and tokens never transfer account ownership", async () => {
  const resources = { ...empty, reads: [{ path: "/fixture/account-a/sessions", kind: "codex-logs" as const }] };
  const a = createCallAuthority(fakeCtx(), resources, { deadlineMs: Date.now() + 10000 });
  resources.reads[0].path = "/fixture/account-b/sessions";
  const b = createCallAuthority(fakeCtx(), { ...empty, reads: [{ path: "/fixture/account-b/sessions", kind: "codex-logs" }] }, { deadlineMs: Date.now() + 10000 });
  expect(a.token).not.toBe(b.token);
  expect(a.resources.reads[0].path).toBe("/fixture/account-a/sessions");
  await a.revoke();
  expect(() => a.assertActive()).toThrow();
  expect(() => b.assertActive()).not.toThrow();
  await b.revoke();
});

test("reentrant abort observers cannot bypass owned cleanup settlement", async () => {
  const authority = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let clean = false;
  authority.onRevoke(async () => { await held; clean = true; });
  authority.signal.addEventListener("abort", () => { void authority.revoke(); });
  let returned = false;
  const revoked = authority.revoke().then(() => { returned = true; });
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  release(); await revoked;
  expect(clean).toBe(true);
});

test("cleanup failure is surfaced rather than certified as successful revocation", async () => {
  const authority = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000 });
  authority.onRevoke(() => { throw Error("fixture owned cleanup failed"); });
  await expect(authority.revoke()).rejects.toThrow("fixture owned cleanup failed");
});

test("grants are captured per call and never inferred from resource possession", async () => {
  const grants = ["fs.read"];
  const a = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000, grants });
  const b = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000 });
  grants.push("process.spawn");
  expect(() => a.assertGranted("fs.read")).not.toThrow();
  expect(() => a.assertGranted("process.spawn")).toThrow("not granted");
  expect(() => b.assertGranted("fs.read")).toThrow("not granted");
  await Promise.all([a.revoke(), b.revoke()]);
});

test("one call cannot overlap FS state and output capability windows", async () => {
  const authority = createCallAuthority(fakeCtx(), empty, { deadlineMs: Date.now() + 10000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fs = authority.exclusive(() => held);
  await expect(authority.exclusive(async () => "state chunk")).rejects.toMatchObject({ code: "conflict" });
  await expect(authority.exclusive(async () => "output chunk")).rejects.toMatchObject({ code: "conflict" });
  let revoked = false;
  const cleanup = authority.revoke().then(() => { revoked = true; });
  await Promise.resolve(); expect(revoked).toBe(false);
  release(); await expect(fs).rejects.toThrow("expired"); await cleanup;
});
