import { beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import { fakeKeychain } from "./fake-keychain";
import { outboxPath } from "../src/link/paths";
import { clearIdentityCache, ensureIdentity, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected, readSalt, writeSalt } from "../src/identity/salt";
import { homeTag } from "../src/identity/key-store";
import { rotateIdentity, type RotationStep } from "../src/identity/rotate";
import { verifyFrom } from "../src/identity/sign";
import type { Ctx } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("darwin"); });

const keyAccount = (ctx: Ctx) => `machine-identity/${homeTag(ctx)}`;
const stagingAccount = (ctx: Ctx) => `machine-identity-staging/${homeTag(ctx)}`;
const saltAccount = (ctx: Ctx) => `machine-install-salt/${homeTag(ctx)}`;
const announced = (ctx: Ctx) => existsSync(outboxPath(ctx)) && readFileSync(outboxPath(ctx), "utf8").includes("rotated");

async function reload(ctx: Ctx) { clearIdentityCache(); return ensureIdentity(ctx); }

for (const code of [0, 36]) {
  test(`a Keychain update that fails during rotation (exit ${code}) fails the rotation and announces nothing`, async () => {
    const kc = fakeKeychain();
    const ctx = fakeCtx({ run: kc.run });
    const old = await ensureIdentity(ctx);
    const before = readMeta(ctx)!;
    kc.fail.write = (a) => a === keyAccount(ctx) ? code : undefined;
    await expect(rotateIdentity(ctx)).rejects.toThrow(/keychain write failed/);
    expect(announced(ctx)).toBe(false);
    expect(readMeta(ctx)).toEqual(before);
    expect(kc.has(stagingAccount(ctx))).toBe(false);
    expect((await reload(ctx)).id).toBe(old.id);
    expect(await cloneSuspected(ctx)).toBe(false);
  });
}

test("a failing Keychain write on first creation fails and records nothing", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  kc.fail.write = () => 0;
  await expect(ensureIdentity(ctx)).rejects.toThrow(/keychain write failed/);
  expect(readMeta(ctx)).toBeNull();
});

for (const code of [0, 36]) {
  test(`a failing salt write (exit ${code}) fails identity creation instead of marking the home copied later`, async () => {
    const kc = fakeKeychain();
    const ctx = fakeCtx({ run: kc.run });
    kc.fail.write = (a) => a === saltAccount(ctx) ? code : undefined;
    await expect(ensureIdentity(ctx)).rejects.toThrow(/keychain write failed/);
    expect(readMeta(ctx)).toBeNull();
    kc.fail.write = undefined;
    await reload(ctx);
    expect(await cloneSuspected(ctx)).toBe(false);
    expect(readMeta(ctx)?.cloneDetected).toBeUndefined();
  });
}

test("writeSalt verifies the stored value", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  const salt = await writeSalt(ctx);
  expect(await readSalt(ctx)).toBe(salt);
});

test("a salt read error is an error, not a missing salt, and does not mark the home copied", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  await ensureIdentity(ctx);
  kc.fail.read = (a) => a === saltAccount(ctx) ? 36 : undefined;
  await expect(readSalt(ctx)).rejects.toThrow(/keychain read failed/);
  await expect(reload(ctx)).rejects.toThrow(/keychain read failed/);
  expect(readMeta(ctx)?.cloneDetected).toBeUndefined();
  kc.fail.read = undefined;
  await reload(ctx);
  expect(await cloneSuspected(ctx)).toBe(false);
});

test("a missing salt (exit 44) still reads as missing", async () => {
  const ctx = fakeCtx({ run: fakeKeychain().run });
  expect(await readSalt(ctx)).toBeNull();
});

test("machine.json keeps the signed statement of the last rotation", async () => {
  const kc = fakeKeychain();
  const ctx = fakeCtx({ run: kc.run });
  const r = await rotateIdentity(ctx);
  const meta = readMeta(ctx)!;
  expect(meta.pendingRotation).toBeUndefined();
  expect(meta.lastRotation).toEqual({ oldId: r.oldId, newId: r.newId, signature: r.signature, at: ctx.now });
  expect(kc.has(stagingAccount(ctx))).toBe(false);
});

const STEPS: RotationStep[] = ["pending", "staged", "swapped", "salted", "unstaged", "committed"];
for (const platform of ["darwin", "linux"] as const) {
  for (const step of STEPS) {
    test(`a rotation interrupted after ${step} (${platform}) is ${step === "pending" ? "rolled back" : "completed"} on the next load`, async () => {
      setIdentityPlatformForTests(platform);
      const kc = fakeKeychain();
      const ctx = fakeCtx({ run: kc.run });
      const old = await ensureIdentity(ctx);
      const rev = readMeta(ctx)!.rev;
      let newId = "";
      await expect(rotateIdentity(ctx, { afterStep: (s, id) => { newId = id; if (s === step) throw new Error("crash"); } })).rejects.toThrow("crash");
      const loaded = await reload(ctx);
      const meta = readMeta(ctx)!;
      expect(meta.pendingRotation).toBeUndefined();
      expect(meta.cloneDetected).toBeUndefined();
      expect(await cloneSuspected(ctx)).toBe(false);
      if (step === "pending") {
        expect(loaded.id).toBe(old.id);
        expect(meta.rev).toBe(rev);
        expect(meta.lastRotation).toBeUndefined();
        expect(announced(ctx)).toBe(false);
      } else {
        expect(loaded.id).toBe(newId);
        expect(meta).toMatchObject({ rev: rev + 1, publicId: newId, rotatedFrom: old.id });
        const sig = Buffer.from(meta.lastRotation!.signature, "base64");
        expect(verifyFrom(old.id, "pacer", "rotate", new TextEncoder().encode(`${old.id}\0${newId}`), sig)).toBe(true);
        expect(announced(ctx)).toBe(step !== "committed");
      }
      if (platform === "darwin") expect(kc.has(stagingAccount(ctx))).toBe(false);
      else expect(existsSync(join(ctx.pacerHome, "identity", "machine.key.staging"))).toBe(false);
      clearIdentityCache();
      expect((await ensureIdentity(ctx)).id).toBe(loaded.id);
    });
  }
}
