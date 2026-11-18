import { beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { clearIdentityCache, ensureIdentity, identityBackend, readMeta, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected, saltPath } from "../src/identity/salt";
import { homeTag } from "../src/identity/key-store";
import { fakeKeychain } from "./fake-keychain";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests(undefined); });

test("homeTag is 16 hex characters, stable for one home and different across homes", () => {
  const a = fakeCtx(), b = fakeCtx();
  expect(homeTag(a)).toMatch(/^[0-9a-f]{16}$/);
  expect(homeTag(a)).toBe(homeTag(a));
  expect(homeTag(a)).not.toBe(homeTag(b));
});

test("homeTag does not change when the home is created after the first lookup", () => {
  const ctx = fakeCtx();
  const before = homeTag(ctx);
  mkdirSync(ctx.pacerHome, { recursive: true });
  expect(homeTag(ctx)).toBe(before);
});

test("two homes on the keychain backend use separate accounts and never overwrite each other", async () => {
  const kc = fakeKeychain();
  const a = fakeCtx({ run: kc.run }), b = fakeCtx({ run: kc.run });
  const idA = await ensureIdentity(a, { platform: "darwin" });
  const idB = await ensureIdentity(b, { platform: "darwin" });
  expect(idB.id).not.toBe(idA.id);
  expect([...kc.accounts].sort()).toEqual([
    `machine-identity/${homeTag(a)}`, `machine-identity/${homeTag(b)}`,
    `machine-install-salt/${homeTag(a)}`, `machine-install-salt/${homeTag(b)}`,
  ].sort());
  expect([...kc.items.keys()].every((k) => k.startsWith("pacer|"))).toBe(true);
  clearIdentityCache();
  expect((await ensureIdentity(a, { platform: "darwin" })).id).toBe(idA.id);
  expect((await ensureIdentity(b, { platform: "darwin" })).id).toBe(idB.id);
  expect(await cloneSuspected(a, "darwin")).toBe(false);
  expect(await cloneSuspected(b, "darwin")).toBe(false);
});

test("a home copied to a new path on the keychain backend is suspected as a clone", async () => {
  const kc = fakeKeychain();
  const a = fakeCtx({ run: kc.run });
  await ensureIdentity(a, { platform: "darwin" });
  const copy = fakeCtx({ run: kc.run });
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  expect(await cloneSuspected(copy, "darwin")).toBe(true);
  expect(await cloneSuspected(a, "darwin")).toBe(false);
});

test("each home has its own salt file and a copied home on the file backend is suspected as a clone", async () => {
  const state = tmpDir();
  const a = fakeCtx({ env: { XDG_STATE_HOME: state } }), b = fakeCtx({ env: { XDG_STATE_HOME: state } });
  const idA = await ensureIdentity(a, { platform: "linux" });
  await ensureIdentity(b, { platform: "linux" });
  expect(saltPath(a)).toBe(join(state, "pacer", "install-salt", homeTag(a)));
  expect(saltPath(b)).not.toBe(saltPath(a));
  expect(statSync(join(state, "pacer", "install-salt")).mode & 0o777).toBe(0o700);
  expect(statSync(saltPath(a)).mode & 0o777).toBe(0o600);
  expect(await cloneSuspected(a, "linux")).toBe(false);
  expect(await cloneSuspected(b, "linux")).toBe(false);
  const copy = fakeCtx({ env: { XDG_STATE_HOME: state } });
  cpSync(a.pacerHome, copy.pacerHome, { recursive: true });
  expect(await cloneSuspected(copy, "linux")).toBe(true);
  clearIdentityCache();
  expect((await ensureIdentity(a, { platform: "linux" })).id).toBe(idA.id);
  expect(await cloneSuspected(a, "linux")).toBe(false);
});

test("a HOME without a login Keychain keeps the identity in files and never runs security", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({ run: async argv => { calls.push(argv); return { code: 1, stdout: "", stderr: "" }; } });
  const saved = process.env.HOME;
  try {
    process.env.HOME = ctx.home;
    expect(identityBackend()).toBe("file");
    const first = await ensureIdentity(ctx);
    expect(readMeta(ctx)?.backend).toBe("file");
    expect(statSync(saltPath(ctx)).isFile()).toBe(true);
    expect(calls).toEqual([]);
    if (process.platform === "darwin") {
      mkdirSync(join(ctx.home, "Library", "Keychains"), { recursive: true });
      writeFileSync(join(ctx.home, "Library", "Keychains", "login.keychain-db"), "");
      expect(identityBackend()).toBe("keychain");
      // The identity keeps its recorded backend for both key and salt, so it is not mistaken for a copy.
      clearIdentityCache();
      const again = await ensureIdentity(ctx);
      expect(again.id).toBe(first.id);
      expect(await cloneSuspected(ctx)).toBe(false);
      expect(calls).toEqual([]);
    }
    // A platform chosen by a caller or test still decides on its own.
    expect(identityBackend("darwin")).toBe("keychain");
  } finally {
    process.env.HOME = saved;
  }
});
