#!/usr/bin/env bun
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assetFile, hostTarget, parseManifest, sha256Hex } from "../../src/update/manifest";
import { CASES, runCase } from "../../conformance/run";

export function validateM1Artifacts(dir: string): { version: string; front: string; core: string } {
  const target = hostTarget();
  if (!target) throw Error("No release target for this host");
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const asset = manifest.assets.find(a => a.file === assetFile(target));
  const companion = asset?.companions?.[0];
  if (!asset || !companion) throw Error("M1 requires a host front door and core companion");
  for (const entry of [asset, companion]) {
    const path = join(dir, entry.file), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Release artifact is not a regular file: ${entry.file}`);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256) throw Error(`Release artifact checksum/size mismatch: ${entry.file}`);
  }
  return { version: manifest.version, front: join(dir, asset.file), core: join(dir, companion.file) };
}

export function validateNativeRegistry(source: string): void {
  const registries = [...source.matchAll(/static OPS: &\[NativeOp\] = &\[([\s\S]*?)\];/g)];
  if (registries.length !== 1) throw Error("Cannot verify feature-gated native registry");
  const body = registries[0][1];
  const modules: Record<string, string> = {
    engine_ops: "crates/config-ops/src/engine_ops.rs",
    setup_ops: "crates/config-ops/src/setup_ops.rs",
    status_ops: "crates/task-ops/src/status_ops.rs",
    desktop_reconcile_ops: "crates/update/src/desktop_reconcile_ops.rs",
  };
  const entry = /\s*(#\[cfg\(feature = "test-ops"\)\]\s*)?NativeOp\s*\{\s*name:\s*(?:"([^"]+)"|(\w+)::ops\(\)\[(\d+)\]\.name)\s*,\s*call:\s*([\w:]+(?:\(\)\[\d+\]\.call)?)\s*,\s*\}\s*,/gy;
  const testNames: string[] = [];
  let offset = 0;
  while (offset < body.length && body.slice(offset).trim()) {
    entry.lastIndex = offset;
    const match = entry.exec(body);
    if (!match) throw Error("Cannot verify feature-gated native registry");
    const [, feature, literal, module, index, call] = match;
    let name = literal;
    if (module) {
      if (feature || !modules[module] || call !== `${module}::ops()[${index}].call`) throw Error("Cannot verify feature-gated native registry");
      const path = join(import.meta.dir, "../..", modules[module]);
      const moduleSource = readFileSync(path, "utf8");
      const ops = [...moduleSource.matchAll(/pub const fn ops\(\)[\s\S]*?\{([\s\S]*?)\n\}/g)];
      if (ops.length !== 1) throw Error("Cannot verify feature-gated native registry");
      const array = ops[0][1].match(/&\[([\s\S]*?)\]/);
      if (!array) throw Error("Cannot verify feature-gated native registry");
      const moduleEntry = /\s*(?:pacer_foundation::api::)?NativeOp\s*\{\s*name:\s*"([^"]+)"\s*,\s*call:\s*[\w:]+\s*,\s*\}\s*,?/gy;
      const entries: string[] = [];
      let position = 0;
      while (position < array[1].length && array[1].slice(position).trim()) {
        moduleEntry.lastIndex = position;
        const item = moduleEntry.exec(array[1]);
        if (!item) throw Error("Cannot verify feature-gated native registry");
        entries.push(item[1]);
        position = moduleEntry.lastIndex;
      }
      name = entries[Number(index)];
      if (!name) throw Error("Cannot verify feature-gated native registry");
    }
    if (feature) testNames.push(name);
    else if (name === "test.echo" || name === "_debug.native") throw Error("Cannot verify feature-gated native registry");
    offset = entry.lastIndex;
  }
  if (testNames.length !== 2 || !testNames.includes("test.echo") || !testNames.includes("_debug.native")) {
    throw Error("Native test operation coverage changed");
  }
}

/** `all` runs every check; `skip` runs every check but the Bun suite; `shard` runs only one CI shard of it. */
export type BunSuite = "all" | "skip" | "shard";

export function parseGateArgs(args: string[]): { dir: string; suite: BunSuite } {
  const usage = "usage: bun run gate:m1 --release-dir <version-directory> [--bun-suite all|skip|shard]";
  if (args[0] !== "--release-dir" || !args[1] || (args.length !== 2 && args.length !== 4)) throw Error(usage);
  const suite = args.length === 2 ? "all" : args[2] === "--bun-suite" ? args[3] : undefined;
  if (suite !== "all" && suite !== "skip" && suite !== "shard") throw Error(usage);
  return { dir: args[1], suite };
}

/** The test files of shard SHARD_INDEX of SHARD_COUNT, partitioned exactly as CI's sharded suite. */
export function shardTestFiles(root: string, env: NodeJS.ProcessEnv): string[] {
  const index = env.SHARD_INDEX ?? "", count = env.SHARD_COUNT ?? "";
  if (!/^\d+$/.test(index) || !/^[1-9]\d*$/.test(count) || Number(index) >= Number(count)) {
    throw Error("Shard mode needs SHARD_INDEX below a positive SHARD_COUNT");
  }
  const result = Bun.spawnSync(["python3", "scripts/ci/shard-tests.py"], { cwd: root, env: { ...process.env, SHARD_INDEX: index, SHARD_COUNT: count }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw Error(`Cannot list shard test files: ${result.stderr.toString().trim()}`);
  const files = JSON.parse(result.stdout.toString()) as string[];
  if (!files.length) throw Error(`Shard ${index} of ${count} has no test files`);
  return files;
}

async function gate(dir: string, suite: BunSuite = "all"): Promise<number> {
  const root = resolve(import.meta.dir, "../..");
  if (process.env.PACER_CORE_ARGV) throw Error("Unset PACER_CORE_ARGV: M1 gate must use the released companion");
  const artifacts = validateM1Artifacts(dir);
  const files = suite === "shard" ? shardTestFiles(root, process.env) : [];
  const checks = suite !== "shard";
  const temporary = mkdtempSync(join(tmpdir(), "pacer-m1-gate-"));
  chmodSync(temporary, 0o700);
  const front = join(temporary, "pacer"), core = join(temporary, "pacer-core"), home = join(temporary, "home");
  const testFront = join(temporary, "target", "debug", "pacer");
  mkdirSync(home, { mode: 0o700 });
  copyFileSync(artifacts.front, front); copyFileSync(artifacts.core, core);
  chmodSync(front, 0o755); chmodSync(core, 0o755);
  const buildHome = process.env.HOME ?? tmpdir();
  const env = { ...process.env, HOME: home, PACER_HOME: join(home, ".pacer"),
    CARGO_HOME: process.env.CARGO_HOME ?? join(buildHome, ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(buildHome, ".rustup"),
    PACER_BIN: undefined, PACER_CORE_ARGV: undefined, PACER_TEST_FRONT_DOOR: undefined, PACER_TEST_NATIVE_FRONT_DOOR: undefined,
    PACER_NO_SELF_REPAIR: "1", PACER_NO_UPDATE_CHECK: "1", TZ: "Asia/Ho_Chi_Minh" };
  let failures = 0;
  const step = async (name: string, run: () => Promise<void>) => {
    try { await run(); console.log(`PASS ${name}`); return true; }
    catch (error) { failures++; console.error(`FAIL ${name}: ${(error as Error).message}`); return false; }
  };
  const command = async (argv: string[], extra: NodeJS.ProcessEnv = {}) => {
    const child = Bun.spawn(argv, { cwd: root, env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    console.log(out); if (err) console.error(err);
    if (code !== 0) throw Error(`${argv.join(" ")} exited ${code}`);
  };
  try {
    if (!await step("paired artifact versions", async () => {
      for (const path of [front, core]) {
        const result = Bun.spawnSync([path, "--version"], { env, timeout: 15000, stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0 || result.stdout.toString().trim() !== `pacer ${artifacts.version}`) throw Error("Front door and core must report the manifest version");
      }
    })) return 1;
    if (checks) await step("native startup beats the Bun core (20-run medians)", async () => {
      const median = (path: string) => {
        const samples = Array.from({ length: 20 }, () => {
          const start = performance.now();
          const result = Bun.spawnSync([path, "--version"], { env, timeout: 15000, stdout: "ignore", stderr: "pipe" });
          if (result.exitCode !== 0) throw Error("Startup probe failed");
          return performance.now() - start;
        }).sort((a, b) => a - b);
        return (samples[9] + samples[10]) / 2;
      };
      const rust = median(front), bun = median(core);
      console.log(`Rust ${rust.toFixed(2)} ms; Bun ${bun.toFixed(2)} ms`);
      if (rust >= bun) throw Error("Rust startup median is not below the core's");
    });
    if (checks) {
      await step("plugin conformance against released front door", async () => {
        for (const entry of CASES) { await runCase(entry, [front], join(temporary, "conformance")); console.log(`  PASS ${entry.name}`); }
      });
      await step("released transport parity", () => command([process.execPath, "test", "test/transport-parity.test.ts"], { PACER_TEST_FRONT_DOOR: front }));
      await step("native operation parity coverage", async () => {
        const source = readFileSync(join(root, "crates/server/src/native.rs"), "utf8");
        validateNativeRegistry(source);
      });
      await step("Rust workspace", () => command(["cargo", "test", "--workspace", "--locked"]));
    }
    if (suite !== "skip") {
      if (!await step("build isolated native test front door", () => command(["cargo", "build", "--locked", "-p", "pacer", "--features", "test-ops", "--target-dir", join(temporary, "target")]))) return 1;
      await step(suite === "shard" ? `Bun suite shard ${process.env.SHARD_INDEX} of ${process.env.SHARD_COUNT}` : "Bun suite", () => command([process.execPath, "run", "test", ...files], {
        PACER_TEST_FRONT_DOOR: front, PACER_TEST_NATIVE_FRONT_DOOR: testFront, PACER_TEST_REFERENCE_CORE: core,
      }));
    }
    if (checks) {
      await step("crate LOC", () => command(["cargo", "xtask", "loc", "--check"]));
      await step("crate dependencies", () => command(["cargo", "xtask", "deps"]));
    }
    return failures ? 1 : 0;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const { dir, suite } = parseGateArgs(process.argv.slice(2));
  try { process.exitCode = await gate(resolve(dir), suite); }
  catch (error) { console.error(`FAIL M1 gate: ${(error as Error).message}`); process.exitCode = 1; }
}
