#!/usr/bin/env bun
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function gate(dir: string): Promise<number> {
  const root = resolve(import.meta.dir, "../..");
  if (process.env.PACER_CORE_ARGV) throw Error("Unset PACER_CORE_ARGV: M1 gate must use the released companion");
  const artifacts = validateM1Artifacts(dir);
  const temporary = mkdtempSync(join(tmpdir(), "pacer-m1-gate-"));
  chmodSync(temporary, 0o700);
  const front = join(temporary, "pacer"), core = join(temporary, "pacer-core"), home = join(temporary, "home");
  mkdirSync(home, { mode: 0o700 });
  copyFileSync(artifacts.front, front); copyFileSync(artifacts.core, core);
  chmodSync(front, 0o755); chmodSync(core, 0o755);
  const buildHome = process.env.HOME ?? tmpdir();
  const env = { ...process.env, HOME: home, PACER_HOME: join(home, ".pacer"),
    CARGO_HOME: process.env.CARGO_HOME ?? join(buildHome, ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(buildHome, ".rustup"),
    PACER_BIN: undefined, PACER_CORE_ARGV: undefined, PACER_NO_SELF_REPAIR: "1", PACER_NO_UPDATE_CHECK: "1", TZ: "Asia/Ho_Chi_Minh" };
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
    await step("native startup beats the Bun core (20-run medians)", async () => {
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
    await step("plugin conformance against released front door", async () => {
      for (const entry of CASES) { await runCase(entry, [front], join(temporary, "conformance")); console.log(`  PASS ${entry.name}`); }
    });
    await step("released transport parity", () => command([process.execPath, "test", "test/transport-parity.test.ts"], { PACER_TEST_FRONT_DOOR: front }));
    await step("native operation parity coverage", async () => {
      const source = readFileSync(join(root, "crates/server/src/native.rs"), "utf8");
      const match = /pub\s+const\s+NATIVE_OPS\s*:\s*&\s*\[\s*&str\s*\]\s*=\s*&\s*\[([\s\S]*?)\]\s*;/.exec(source);
      if (!match) throw Error("Cannot inspect NATIVE_OPS");
      for (const [, op] of match[1].matchAll(/"([^"]+)"/g)) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(op) || !existsSync(join(root, "test/parity", `${op}.test.ts`))) throw Error(`Missing native parity suite: ${op}`);
      }
    });
    await step("Rust workspace", () => command(["cargo", "test", "--workspace", "--locked"]));
    await step("Bun suite", () => command([process.execPath, "run", "test"], { PACER_TEST_FRONT_DOOR: front }));
    await step("crate LOC", () => command(["cargo", "xtask", "loc", "--check"]));
    await step("crate dependencies", () => command(["cargo", "xtask", "deps"]));
    return failures ? 1 : 0;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--release-dir") throw Error("usage: bun run gate:m1 --release-dir <version-directory>");
  try { process.exitCode = await gate(resolve(args[1])); }
  catch (error) { console.error(`FAIL M1 gate: ${(error as Error).message}`); process.exitCode = 1; }
}
