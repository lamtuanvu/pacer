import { beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { clearIdentityCache, ensureIdentity, readMeta, setIdentityPlatformForTests, setMachineName, type MachineIdentity } from "../src/identity/store";
import { rotateIdentity } from "../src/identity/rotate";
import { CoreError } from "../src/core/errors";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("linux"); });

const linux = { platform: "linux" as const };

test("a rename and a rotate started together both land in machine.json", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, linux);
  const [, r] = await Promise.all([setMachineName(ctx, "studio", before.rev), rotateIdentity(ctx, linux)]);
  const meta = readMeta(ctx)!;
  expect(meta.rev).toBe(before.rev + 2);
  expect(meta.name).toBe("studio");
  expect(meta.rotatedFrom).toBe(before.id);
  expect(meta.publicId).toBe(r.newId);
  expect(existsSync(join(ctx.pacerHome, "orca", "identity.lock"))).toBe(false);
});

test("a rename issued during a rotation is applied or rejected, never lost", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, linux);
  let rename: Promise<unknown> | undefined;
  const r = await rotateIdentity(ctx, { ...linux, afterStep: s => { if (s === "staged") rename = setMachineName(ctx, "studio", before.rev).catch(e => e); } });
  const outcome = await rename!;
  const meta = readMeta(ctx)!;
  expect(meta.publicId).toBe(r.newId);
  expect(meta.rotatedFrom).toBe(before.id);
  if (outcome instanceof CoreError) {
    expect(outcome.code).toBe("conflict");
    expect(meta.name).toBe(before.name);
    expect(meta.rev).toBe(before.rev + 1);
  } else {
    expect(meta.name).toBe("studio");
    expect(meta.rev).toBe(before.rev + 2);
  }
});

test("two concurrent rotations chain instead of losing a key", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, linux);
  const results = await Promise.allSettled([rotateIdentity(ctx, linux), rotateIdentity(ctx, linux)]);
  const ok = results.flatMap(x => x.status === "fulfilled" ? [x.value] : []);
  for (const x of results) if (x.status === "rejected") expect((x.reason as CoreError).code).toBe("conflict");
  expect(ok[0]!.oldId).toBe(before.id);
  if (ok.length === 2) expect(ok[1]!.oldId).toBe(ok[0]!.newId);
  const last = ok.at(-1)!;
  clearIdentityCache();
  const now = await ensureIdentity(ctx, linux);
  expect(now.id).toBe(last.newId);
  const meta = readMeta(ctx)!;
  expect(meta.rotatedFrom).toBe(last.oldId);
  expect(meta.rev).toBe(before.rev + ok.length);
  expect(meta.pendingRotation).toBeUndefined();
});

test("another process loading mid-rotation waits for the lock and sees the committed key", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, linux);
  let other: Promise<MachineIdentity> | undefined;
  const r = await rotateIdentity(ctx, { ...linux, afterStep: s => {
    if (s === "staged") { clearIdentityCache(); other = ensureIdentity(ctx, linux); } // a second process has no cache
  } });
  const seen = await other!;
  expect(seen.id).toBe(r.newId);
  expect(seen.rev).toBe(before.rev + 1);
  const meta = readMeta(ctx)!;
  expect(meta.publicId).toBe(r.newId);
  expect(meta.pendingRotation).toBeUndefined();
});

test("another process renaming mid-rotation re-reads machine.json inside the lock", async () => {
  const ctx = fakeCtx();
  const before = await ensureIdentity(ctx, linux);
  let rename: Promise<unknown> | undefined;
  const r = await rotateIdentity(ctx, { ...linux, afterStep: s => {
    if (s === "pending") { clearIdentityCache(); rename = setMachineName(ctx, "studio", before.rev + 1); }
  } });
  await rename;
  const meta = readMeta(ctx)!;
  expect(meta.name).toBe("studio");
  expect(meta.rev).toBe(before.rev + 2);
  expect(meta.publicId).toBe(r.newId);
});
