import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublisherTrust } from "../src/plugins/publishers";
import { PluginRegistry } from "../src/plugins/registry";
import { fakeCtx, tmpDir } from "./helpers";

const keys = (raw: number) => Buffer.alloc(32, raw).toString("base64");
function fixture() {
  const home = realpathSync(tmpDir()), ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  mkdirSync(ctx.pacerHome, { mode: 0o700 });
  return { ctx, path: join(ctx.pacerHome, "plugins", "publishers.json") };
}

test("trust requires canonical 32-byte key and exact expected fingerprint", async () => {
  const { ctx, path } = fixture(), trust = createPublisherTrust({});
  await expect(trust.set(ctx, "Fixture", "bad", null)).rejects.toThrow("key");
  await expect(trust.set(ctx, "Fixture", Buffer.alloc(31).toString("base64"), null)).rejects.toThrow("key");
  const first = await trust.set(ctx, "Fixture", keys(1), null);
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(trust.lookup(ctx, "Fixture")).toEqual({ key: keys(1), fingerprint: first.fingerprint!, source: "user" });
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  await expect(trust.set(ctx, "Fixture", keys(2), null)).rejects.toThrow("conflict");
  const rotated = await trust.set(ctx, "Fixture", keys(2), first.fingerprint);
  expect(rotated.fingerprint).not.toBe(first.fingerprint);
  await expect(trust.set(ctx, "Fixture", null, first.fingerprint)).rejects.toThrow("conflict");
  expect(await trust.set(ctx, "Fixture", null, rotated.fingerprint)).toEqual({ fingerprint: null });
  expect(trust.lookup(ctx, "Fixture")).toBeNull();
});

test("trust migration tightens an owned 0755 manual plugin root without changing its contents", async () => {
  const { ctx, path } = fixture(), root = join(ctx.pacerHome, "plugins"), trust = createPublisherTrust({});
  mkdirSync(root, { mode: 0o755 });
  const manual = join(root, "fx-manual");
  mkdirSync(manual);
  writeFileSync(join(manual, "pacer-plugin.json"), JSON.stringify({ id: "fx-manual", version: "1.0.0", publisher: "Fixture", host: "*", entry: "main.js", contributes: {}, capabilities: [] }));
  writeFileSync(join(manual, "main.js"), "");
  await trust.set(ctx, "Fixture", keys(6), null);
  expect(lstatSync(root).mode & 0o777).toBe(0o700);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw new Error("unused"); } });
  expect(registry.list(ctx).find(plugin => plugin.id === "fx-manual")?.state).toBe("needs_grant");
  await registry.shutdown();
});

test("symlinked PACER_HOME or ancestor refuses trust before any outside mutation", async () => {
  const outside = realpathSync(tmpDir()), parent = realpathSync(tmpDir()), trust = createPublisherTrust({});
  const direct = join(parent, "direct");
  symlinkSync(outside, direct);
  await expect(trust.set(fakeCtx({ home: parent, pacerHome: direct }), "Fixture", keys(7), null)).rejects.toThrow("redirected");
  const nested = join(parent, "nested");
  symlinkSync(outside, nested);
  await expect(trust.set(fakeCtx({ home: parent, pacerHome: join(nested, ".pacer") }), "Fixture", keys(7), null)).rejects.toThrow("redirected");
  expect(existsSync(join(outside, "plugins", "publishers.json"))).toBe(false);
  expect(existsSync(join(outside, "orca"))).toBe(false);
});

test("shipped publishers cannot be overridden or revoked by user trust", async () => {
  const { ctx, path } = fixture(), trust = createPublisherTrust({ pacer: keys(3) });
  expect(trust.lookup(ctx, "pacer")).toMatchObject({ key: keys(3), source: "shipped" });
  await expect(trust.set(ctx, "pacer", keys(4), null)).rejects.toThrow("shipped");
  await expect(trust.set(ctx, "pacer", null, null)).rejects.toThrow("shipped");
  mkdirSync(join(ctx.pacerHome, "plugins"), { mode: 0o700 });
  writeFileSync(path, JSON.stringify({ version: 1, publishers: { pacer: keys(4) } }, null, 2) + "\n", { mode: 0o600 });
  expect(() => trust.lookup(ctx, "pacer")).toThrow("shadows");
});

test("private trust store rejects symlink, loose mode and tampering", async () => {
  const { ctx, path } = fixture(), trust = createPublisherTrust({});
  mkdirSync(join(ctx.pacerHome, "plugins"), { mode: 0o700 });
  const target = join(ctx.pacerHome, "other.json");
  writeFileSync(target, "{}");
  symlinkSync(target, path);
  expect(() => trust.lookup(ctx, "Fixture")).toThrow("private");
  unlinkSync(path);
  await trust.set(ctx, "Fixture", keys(5), null);
  chmodSync(path, 0o644);
  expect(() => trust.lookup(ctx, "Fixture")).toThrow("private");
  chmodSync(path, 0o600);
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace('"version": 1', '"version": 2'));
  expect(() => trust.lookup(ctx, "Fixture")).toThrow("invalid");
  unlinkSync(path);
  symlinkSync("missing", path);
  expect(() => trust.lookup(ctx, "Fixture")).toThrow("private");
});
