import { expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeKey, readKey, hasKey, deleteKey } from "../src/endpoints/keys";
import { fakeCtx } from "./helpers";

const secret = "sk-test-only-unique-secret";
test("file keys are private, can be replaced and deleted", async () => {
  const ctx = fakeCtx();
  expect(await readKey(ctx, "test-api", "file")).toBeNull();
  await writeKey(ctx, "test-api", "file", secret);
  const dir = join(ctx.pacerHome, "secrets"), path = join(dir, "test-api.key");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe(secret);
  expect(await hasKey(ctx, "test-api", "file")).toBe(true);
  chmodSync(dir, 0o755); chmodSync(path, 0o644);
  await writeKey(ctx, "test-api", "file", "replacement");
  expect(await readKey(ctx, "test-api", "file")).toBe("replacement");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  await deleteKey(ctx, "test-api", "file");
  await deleteKey(ctx, "test-api", "file");
  expect(await hasKey(ctx, "test-api", "file")).toBe(false);
});
test("keychain writes through stdin and reads only on request", async () => {
  const key = `${secret} with 'single' and "double" quotes`;
  const hex = Buffer.from(key).toString("hex");
  let stored: string | null = null;
  const calls: string[][] = [];
  const ctx = fakeCtx({run: async (argv, timeout, options) => {
    calls.push(argv);
    expect(argv[0]).toBe("security");
    expect(timeout).toBe(10000);
    expect(argv.join(" ")).not.toContain(secret);
    expect(argv.join(" ")).not.toContain(hex);
    if (argv[1] === "-i") {
      expect(argv).toEqual(["security", "-i"]);
      const command = options?.stdin?.match(/^add-generic-password -U -s pacer -a endpoint\/test-api -X ([0-9a-f]+)\n$/);
      expect(command).not.toBeNull();
      expect(command).toBeDefined();
      stored = Buffer.from(command![1], "hex").toString();
      expect(stored).toBe(key);
    } else {
      expect(argv).toContain("pacer"); expect(argv).toContain("endpoint/test-api");
    }
    if (argv[1] === "delete-generic-password") stored = null;
    return {code: stored === null && argv[1] === "find-generic-password" ? 44 : 0, stdout: argv.includes("-w") && stored ? stored + "\n" : "", stderr: ""};
  }});
  expect(await hasKey(ctx, "test-api", "keychain")).toBe(false);
  await writeKey(ctx, "test-api", "keychain", key);
  expect(calls.at(-1)).toEqual(["security", "find-generic-password", "-s", "pacer", "-a", "endpoint/test-api"]);
  expect(await readKey(ctx, "test-api", "keychain")).toBe(key);
  expect(calls.at(-1)).toContain("-w");
  expect(await hasKey(ctx, "test-api", "keychain")).toBe(true);
  await deleteKey(ctx, "test-api", "keychain");
  expect(calls.at(-1)).toEqual(["security", "delete-generic-password", "-s", "pacer", "-a", "endpoint/test-api"]);
  expect(await readKey(ctx, "test-api", "keychain")).toBeNull();
});
test("keychain confirms interactive writes and hides failed command output", async () => {
  const calls: string[][] = [];
  const ctx = fakeCtx({run: async (argv) => {
    calls.push(argv);
    return {code: argv[1] === "-i" ? 0 : 44, stdout: secret, stderr: secret};
  }});
  await expect(writeKey(ctx, "test-api", "keychain", secret)).rejects.toThrow(/^endpoint keychain operation failed$/);
  expect(calls).toEqual([
    ["security", "-i"],
    ["security", "find-generic-password", "-s", "pacer", "-a", "endpoint/test-api"],
  ]);
});
test("env and none never store or delete anything", async () => {
  const ctx = fakeCtx({env: {TEST_KEY: secret}, run: async () => {throw Error("must not run");}});
  expect(await readKey(ctx, "test-api", "env:TEST_KEY")).toBe(secret);
  await deleteKey(ctx, "test-api", "env:TEST_KEY");
  expect(ctx.env.TEST_KEY).toBe(secret);
  expect(await readKey(ctx, "test-api", "env:MISSING")).toBeNull();
  expect(await readKey(ctx, "test-api", "none")).toBeNull();
  expect(await hasKey(ctx, "test-api", "none")).toBe(true);
  await writeKey(ctx, "test-api", "none", secret);
  await deleteKey(ctx, "test-api", "none");
  await expect(writeKey(ctx, "test-api", "env:TEST_KEY", secret)).rejects.toThrow("environment");
});
test("store failures never expose command output or secret values", async () => {
  const ctx = fakeCtx({run: async () => {throw Error(`Authorization: Bearer ${secret}`);}});
  for (const call of [() => writeKey(ctx, "test-api", "keychain", secret), () => readKey(ctx, "test-api", "keychain"), () => deleteKey(ctx, "test-api", "keychain")]) {
    try { await call(); throw Error("expected failure"); } catch (e) {expect(String(e)).not.toContain(secret); expect(String(e)).toContain("keychain");}
  }
});
test("store paths cannot escape the secret directory", async () => {
  const ctx = fakeCtx();
  await expect(writeKey(ctx, "../escape", "file", secret)).rejects.toThrow("name");
});

test("presence checks never request a keychain password", async () => {
  for (const code of [0, 44, 1]) {
    const ctx = fakeCtx({run: async argv => {
      expect(argv).toEqual(["security", "find-generic-password", "-s", "pacer", "-a", "endpoint/test-api"]);
      expect(argv).not.toContain("-w");
      return {code, stdout: "", stderr: ""};
    }});
    if (code === 1) await expect(hasKey(ctx, "test-api", "keychain")).rejects.toThrow("keychain");
    else expect(await hasKey(ctx, "test-api", "keychain")).toBe(code === 0);
  }
  const ctx = fakeCtx({env: {EMPTY: "", PRESENT: secret}});
  expect(await hasKey(ctx, "test-api", "env:EMPTY")).toBe(false);
  expect(await hasKey(ctx, "test-api", "env:PRESENT")).toBe(true);
  await writeKey(ctx, "test-api", "file", secret);
  // Presence is an existence check even when a file has no contents.
  const {writeFileSync} = await import("node:fs");
  writeFileSync(join(ctx.pacerHome, "secrets", "test-api.key"), "");
  expect(await hasKey(ctx, "test-api", "file")).toBe(true);
});
