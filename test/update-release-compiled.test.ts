import { childEnv, closedPort } from "./child-env";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Platform, assetFile, companionFile, hostTarget, nativePluginFile, parseManifest, parseSha256Sums, sha256Hex } from "../src/update/manifest";
import { tmpDir } from "./helpers";

// Every test here reads the one real host release this file compiles: a release compile takes minutes.

const ROOT = resolve(import.meta.dir, "..");
const INSTALL_SH = join(ROOT, "install.sh");
const SHELL = Bun.which("dash") ?? "/bin/sh";
const PKG_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const HOST = hostTarget();
const HAS_ASSISTANT = existsSync(join(ROOT, "crates/assistant-pacer/Cargo.toml"));
// A cold release compile (Rust binaries plus the bundled workflows) on a CI runner now takes three to more than five minutes.
const COMPILE_TIMEOUT_MS = 600_000;

let compiled: Promise<{ out: string; stdout: string; stderr: string; code: number }> | undefined;
const hostRelease = () => compiled ??= (async () => {
  const out = tmpDir();
  const p = Bun.spawn([process.execPath, "scripts/release/build.ts", "--host", "--out", out], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, stdout, stderr, code };
})();

test.skipIf(!HOST)("bun run release --host compiles a working binary with the version embedded", async () => {
  const { out, stdout, stderr, code } = await hostRelease();
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const file = assetFile(HOST as Platform);
  const dir = join(out, PKG_VERSION);
  expect(stdout).toContain(`release ${PKG_VERSION}: ${dir}`);
  const bin = readFileSync(join(dir, file));
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const core = readFileSync(join(dir, companionFile(HOST!)));
  const assistantName = "pacer-assistant-pacer" as const;
  const assistantFile = nativePluginFile(assistantName, HOST!);
  const assistant = HAS_ASSISTANT ? readFileSync(join(dir, assistantFile)) : undefined;
  expect(manifest).toEqual({
    version: PKG_VERSION,
    assets: [{
      os: HOST!.os,
      arch: HOST!.arch,
      file,
      sha256: sha256Hex(bin),
      size: bin.length,
      companions: [{ name: "pacer-core", file: companionFile(HOST!), sha256: sha256Hex(core), size: core.length }],
      ...(assistant ? { nativePlugins: [{ name: assistantName, file: assistantFile, sha256: sha256Hex(assistant), size: assistant.length }] } : {}),
    }],
  });
  const sums = parseSha256Sums(readFileSync(join(dir, "SHA256SUMS"), "utf8"));
  expect(sums.get(companionFile(HOST!))).toBe(sha256Hex(core));
  expect(sums.get(file)).toBe(sha256Hex(bin));
  if (assistant) expect(sums.get(assistantFile)).toBe(sha256Hex(assistant));
  expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual({ version: PKG_VERSION });
  expect(statSync(join(dir, file)).mode & 0o111).not.toBe(0);
  const v = Bun.spawnSync([join(dir, file), "--version"], { env: { ...childEnv(tmpDir()), PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  expect(v.stdout.toString().trim()).toBe(`pacer ${PKG_VERSION}`);
}, COMPILE_TIMEOUT_MS);

test.skipIf(!HOST)("install.sh installs a real compiled host build", async () => {
  const { out, code: built } = await hostRelease();
  expect(built).toBe(0);
  const dir = join(tmpDir(), "bin");
  const p = Bun.spawn([SHELL, INSTALL_SH], { env: { HOME: tmpDir(), PACER_HOME: join(tmpDir(), ".pacer"), TMPDIR: tmpDir(), PATH: process.env.PATH ?? "/usr/bin:/bin",
    PACER_RELEASE_BASE: `file://${out}`, PACER_INSTALL_DIR: dir, PACER_PORT: String(closedPort()) }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain(`installed: pacer ${PKG_VERSION} (${dir}/pacer)`);
  expect(Bun.spawnSync([join(dir, "pacer"), "--version"]).stdout.toString().trim()).toBe(`pacer ${PKG_VERSION}`);
}, COMPILE_TIMEOUT_MS);
