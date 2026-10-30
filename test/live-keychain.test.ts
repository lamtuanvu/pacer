import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { deleteSandboxKeychainItems, installKeychainStub, prepareKeychain } from "../scripts/live/keychain";
import { main } from "../scripts/live/cli";
import type { Session } from "../scripts/live/core";
import { homeTag } from "../src/identity/key-store";
import { clearIdentityCache, ensureIdentity, setIdentityPlatformForTests } from "../src/identity/store";
import { cloneSuspected } from "../src/identity/salt";
import type { RunFn } from "../src/types";

beforeEach(() => { clearIdentityCache(); setIdentityPlatformForTests("darwin"); });

function stub() {
  const root = tmpDir(), bin = join(root, "bin"), store = join(root, "keychain");
  installKeychainStub(bin, store);
  const sh = (args: string[], stdin?: string) => {
    const r = Bun.spawnSync([join(bin, "security"), ...args], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  return { root, bin, store, sh };
}

test("the sandbox security stub stores items under the sandbox and prints values like security -w", () => {
  const { bin, store, sh } = stub();
  expect(statSync(join(bin, "security")).mode & 0o111).not.toBe(0);
  expect(sh(["-i"], `add-generic-password -U -s pacer -a machine-install-salt/abc -X ${Buffer.from("salt").toString("hex")}\n`).code).toBe(0);
  expect(sh(["find-generic-password", "-s", "pacer", "-a", "machine-install-salt/abc", "-w"]).stdout).toBe("salt\n");
  expect(sh(["-i"], `add-generic-password -U -s pacer -a machine-identity/abc -X 00ff10\n`).code).toBe(0);
  expect(sh(["find-generic-password", "-s", "pacer", "-a", "machine-identity/abc", "-w"]).stdout).toBe("00ff10\n");
  expect(sh(["find-generic-password", "-s", "pacer", "-a", "machine-identity/abc"]).stdout).toBe("");
  expect(sh(["find-generic-password", "-s", "pacer", "-a", "missing/abc", "-w"]).code).toBe(44);
  expect(sh(["delete-generic-password", "-s", "pacer", "-a", "machine-identity/abc"]).code).toBe(0);
  expect(sh(["delete-generic-password", "-s", "pacer", "-a", "machine-identity/abc"]).code).toBe(44);
  expect(readdirSync(store)).toEqual(["pacer.machine-install-salt_abc"]);
});

test("the machine identity works through the stub", async () => {
  const { bin } = stub();
  const run: RunFn = async (argv, _t, o) => {
    const r = Bun.spawnSync([join(bin, argv[0]!), ...argv.slice(1)], { stdin: o?.stdin === undefined ? "ignore" : Buffer.from(o.stdin), stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const ctx = fakeCtx({ run });
  const id = await ensureIdentity(ctx);
  clearIdentityCache();
  expect((await ensureIdentity(ctx)).id).toBe(id.id);
  expect(await cloneSuspected(ctx)).toBe(false);
}, 20000);

test("a sandbox gets the stub unless it opts into the real Keychain", () => {
  const root = tmpDir();
  mkdirSync(join(root, "bin"));
  prepareKeychain({ root } as Session);
  expect(statSync(join(root, "bin", "security")).isFile()).toBe(true);
  const real = tmpDir();
  mkdirSync(join(real, "bin"));
  prepareKeychain({ root: real, realKeychain: true } as Session);
  expect(readdirSync(join(real, "bin"))).toEqual([]);
});

test("down deletes the identity items of every home in a real-Keychain sandbox and never the real home's", async () => {
  const root = tmpDir();
  for (const home of ["home", "home-copy"]) { mkdirSync(join(root, home, "identity"), { recursive: true }); writeFileSync(join(root, home, "identity", "machine.json"), "{}"); }
  mkdirSync(join(root, "repo"));
  const calls: string[][] = [];
  const run: RunFn = async argv => { calls.push(argv); return { code: argv.at(-1)!.startsWith("machine-identity-staging/") ? 44 : 0, stdout: "", stderr: "" }; };
  await deleteSandboxKeychainItems(root, run, join(tmpDir(), ".pacer"));
  const expected = ["home", "home-copy"].flatMap(h => ["machine-identity", "machine-identity-staging", "machine-install-salt"].map(p => `${p}/${homeTag({ pacerHome: join(root, h) })}`));
  expect(calls.map(c => c.at(-1)).sort()).toEqual(expected.sort());
  for (const c of calls) expect(c.slice(1, 5)).toEqual(["delete-generic-password", "-s", "pacer", "-a"]);
  calls.length = 0;
  await expect(deleteSandboxKeychainItems(root, run, join(root, "home"))).rejects.toThrow(/real pacer home/);
  expect(calls).toEqual([]);
  await expect(deleteSandboxKeychainItems(root, async () => ({ code: 36, stdout: "", stderr: "" }), join(tmpDir(), ".pacer"))).rejects.toThrow(/Keychain/);
});

test("--real-keychain is only valid for up", async () => {
  await expect(main(["status", "--real-keychain"])).rejects.toThrow("--real-keychain is only valid for up");
});
