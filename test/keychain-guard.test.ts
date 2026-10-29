import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { keychainStubPath } from "./keychain-stub";

const which = (path: string) => Bun.spawnSync(["sh", "-c", "command -v security"], { env: { PATH: path } }).stdout.toString().trim();

test("every test resolves security on PATH to the stub, never the login Keychain tool", () => {
  const found = which(process.env.PATH!);
  expect(found).not.toBe("");
  expect(found).not.toBe("/usr/bin/security");
  expect(found.startsWith(process.env.HOME!)).toBe(true);
});

test("a spawned process stores Keychain items with the stub", () => {
  const root = tmpDir();
  const PATH = keychainStubPath(root);
  expect(which(PATH)).toBe(join(root, "bin", "security"));
  const add = Bun.spawnSync(["security", "add-generic-password", "-U", "-s", "pacer", "-a", "machine-identity/test", "-X", "6869"], { env: { PATH } });
  expect(add.exitCode).toBe(0);
  expect(readdirSync(join(root, "keychain"))).toEqual(["pacer.machine-identity_test"]);
  const read = Bun.spawnSync(["security", "find-generic-password", "-s", "pacer", "-a", "machine-identity/test", "-w"], { env: { PATH } });
  expect(read.stdout.toString().trim()).toBe("hi");
  expect(existsSync(join(root, "keychain", "pacer.machine-identity_other"))).toBe(false);
});
