import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { hostTarget, assetFile, companionFile, sha256Hex } from "../src/update/manifest";
import { gatePlan, parseGateArgs, shardTestFiles, validateM1Artifacts, validateNativeRegistry } from "../scripts/gate/m1";

test("M1 gate modes split the checks between build and shard jobs without dropping one", () => {
  const all = gatePlan("all"), skip = gatePlan("skip"), shard = gatePlan("shard");
  expect(all).toEqual([
    "paired artifact versions", "native startup beats the Bun core (20-run medians)", "plugin conformance against released front door",
    "released transport parity", "native operation parity coverage", "Rust workspace", "build isolated native test front door", "Bun suite",
    "crate LOC", "crate dependencies",
  ]);
  expect(shard).toEqual(["paired artifact versions", "build isolated native test front door", "Bun suite"]);
  expect(skip).toEqual(all.filter(name => !shard.includes(name) || name === "paired artifact versions"));
  expect([...new Set([...skip, ...shard])].sort()).toEqual([...all].sort());
});

test("the shard script lists exactly the tracked files Bun runs as tests", () => {
  const root = join(import.meta.dir, "..");
  const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: root, stdout: "pipe" }).stdout.toString().split("\n");
  const bunTests = tracked.filter(path => !path.split("/").includes("node_modules") && /[._](test|spec)\.[cm]?[jt]sx?$/.test(path));
  expect(bunTests.length).toBeGreaterThan(1000);
  expect(shardTestFiles(root, { SHARD_INDEX: "0", SHARD_COUNT: "1" }).sort()).toEqual(bunTests.sort());
});

test("M1 gate runs the whole Bun suite unless told to skip it or run one shard", () => {
  expect(parseGateArgs(["--release-dir", "dist/1.2.3"])).toEqual({ dir: "dist/1.2.3", suite: "all" });
  for (const suite of ["all", "skip", "shard"] as const) expect(parseGateArgs(["--release-dir", "d", "--bun-suite", suite]).suite).toBe(suite);
  for (const args of [[], ["--release-dir"], ["--release-dir", "d", "--bun-suite"], ["--release-dir", "d", "--bun-suite", "some"], ["--release-dir", "d", "--other", "skip"], ["d", "--release-dir"]]) {
    expect(() => parseGateArgs(args)).toThrow("usage");
  }
});

test("M1 suite shards partition the suite exactly as CI does", () => {
  const root = join(import.meta.dir, "..");
  const shards = [0, 1, 2, 3].map(index => shardTestFiles(root, { SHARD_INDEX: String(index), SHARD_COUNT: "4" }));
  const all = shards.flat();
  expect(new Set(all).size).toBe(all.length);
  expect(all.sort()).toEqual(shardTestFiles(root, { SHARD_INDEX: "0", SHARD_COUNT: "1" }).sort());
  expect(all).toContain("test/m1-gate.test.ts");
  for (const env of [{}, { SHARD_INDEX: "4", SHARD_COUNT: "4" }, { SHARD_INDEX: "0", SHARD_COUNT: "0" }, { SHARD_INDEX: "-1", SHARD_COUNT: "4" }, { SHARD_INDEX: "x", SHARD_COUNT: "4" }]) {
    expect(() => shardTestFiles(root, env)).toThrow("SHARD_INDEX");
  }
});

test("M1 gate requires test operations to remain feature-gated", () => {
  const source = readFileSync(join(import.meta.dir, "../crates/server/src/native.rs"), "utf8");
  expect(() => validateNativeRegistry(source)).not.toThrow();
  for (const name of ["test.echo", "_debug.native"]) {
    const entry = `#[cfg(feature = "test-ops")]\n    NativeOp {\n        name: "${name}"`;
    expect(source).toContain(entry);
    expect(() => validateNativeRegistry(source.replace(entry, entry.replace('#[cfg(feature = "test-ops")]\n    ', "")))).toThrow("feature-gated native registry");
  }
  expect(() => validateNativeRegistry(source.replace('name: "test.echo"', 'name: "different.echo"'))).toThrow("coverage changed");
  expect(() => validateNativeRegistry(source.replace('name: "activity.list"', 'name: "test.echo"'))).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(source.replace('static OPS: &[NativeOp] = &[', 'static OPS: &[NativeOp] = &[\n    unknown_entry(),'))).toThrow("feature-gated native registry");
  expect(() => validateNativeRegistry(source.replace('name: engine_ops::ops()[0].name', 'name: engine_ops::ops()[1].name'))).toThrow("feature-gated native registry");
});

test("M1 gate requires the exact paired host release bytes", () => {
  const target = hostTarget()!;
  const dir = tmpDir(), front = Buffer.from("front"), core = Buffer.from("core");
  const file = assetFile(target), companion = companionFile(target);
  writeFileSync(join(dir, file), front, { mode: 0o755 });
  writeFileSync(join(dir, companion), core, { mode: 0o755 });
  const manifest = { version: "1.2.3", assets: [{ ...target, file, size: front.length, sha256: sha256Hex(front),
    companions: [{ name: "pacer-core", file: companion, size: core.length, sha256: sha256Hex(core) }] }] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  expect(validateM1Artifacts(dir).version).toBe("1.2.3");
  writeFileSync(join(dir, companion), "changed");
  expect(() => validateM1Artifacts(dir)).toThrow("checksum/size");
  manifest.assets[0].companions = [];
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  expect(() => validateM1Artifacts(dir)).toThrow("companion");
});
