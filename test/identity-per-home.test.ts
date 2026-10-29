import { beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected, saltPath } from "../src/identity/salt";
import { homeTag } from "../src/identity/key-store";
import type { RunFn } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests(undefined); });

/** A `security` stand-in keyed by service and account, shared by every home that uses it. */
function fakeKeychain() {
  const items = new Map<string, Buffer>();
  const accounts = new Set<string>();
  const flag = (args: string[], f: string) => args[args.indexOf(f) + 1];
  const one = (args: string[]) => {
    const key = `${flag(args, "-s")}|${flag(args, "-a")}`;
    switch (args[0]) {
      case "add-generic-password":
        accounts.add(flag(args, "-a"));
        items.set(key, Buffer.from(flag(args, "-X"), "hex"));
        return { code: 0, stdout: "", stderr: "" };
      case "find-generic-password": {
        const v = items.get(key);
        if (!v) return { code: 44, stdout: "", stderr: "" };
        if (!args.includes("-w")) return { code: 0, stdout: "", stderr: "" };
        const printable = [...v].every((b) => b >= 0x20 && b < 0x7f);
        return { code: 0, stdout: (printable ? v.toString("latin1") : v.toString("hex")) + "\n", stderr: "" };
      }
      case "delete-generic-password":
        return items.delete(key) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const run: RunFn = async (argv, _timeout, options) => {
    if (argv[0] !== "security") return { code: 127, stdout: "", stderr: "" };
    if (argv[1] !== "-i") return one(argv.slice(1));
    let last = { code: 0, stdout: "", stderr: "" };
    for (const line of (options?.stdin ?? "").split("\n").filter(Boolean)) last = one(line.split(" "));
    return last;
  };
  return { run, items, accounts };
}

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

test("a shared salt file left by an earlier build is replaced by the per-home directory", async () => {
  const state = tmpDir();
  mkdirSync(join(state, "pacer"), { recursive: true });
  writeFileSync(join(state, "pacer", "install-salt"), "old\n");
  const ctx = fakeCtx({ env: { XDG_STATE_HOME: state } });
  await ensureIdentity(ctx, { platform: "linux" });
  expect(statSync(saltPath(ctx)).isFile()).toBe(true);
  expect(await cloneSuspected(ctx, "linux")).toBe(false);
});
