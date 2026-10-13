import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeRelease } from "../scripts/release/build";
import { TARGETS } from "../src/update/manifest";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-brew-")); dirs.push(dir); const release = join(dir, "2.3.4"); mkdirSync(release);
  for (const p of TARGETS) writeFileSync(join(release, `pacer-${p.os}-${p.arch}`), `binary ${p.os}-${p.arch}`);
  const manifest = writeRelease(dir, "2.3.4", TARGETS);
  return { dir, release, manifest, out: join(dir, "Formula/pacer.rb") };
}
function generate(release: string, out: string) {
  return spawnSync(process.execPath, [resolve(import.meta.dir, "../scripts/release/homebrew.ts"), "--manifest", join(release, "manifest.json"), "--out", out], { encoding: "utf8" });
}
test("generates a four-platform formula from release metadata with valid Ruby syntax", () => {
  const { release, manifest, out } = fixture(); expect(generate(release, out).status).toBe(0);
  const text = readFileSync(out, "utf8");
  expect(text).toContain("class Pacer < Formula"); expect(text).toContain('version "2.3.4"'); expect(text).toContain('license "Apache-2.0"');
  for (const asset of manifest.assets) { expect(text).toContain(`https://github.com/lamtuanvu/pacer/releases/download/v2.3.4/${asset.file}`); expect(text).toContain(`sha256 "${asset.sha256}"`); }
  for (const block of ["on_macos", "on_linux", "on_arm", "on_intel", "def install", "test do"]) expect(text).toContain(block);
  expect(text).toContain('bin.install Dir["pacer-*"].first => "pacer"'); expect(text).toContain('assert_match version.to_s, shell_output("#{bin}/pacer --version")');
  const desc = /desc "([^"]+)"/.exec(text)![1]; expect(desc.length).toBeLessThan(80); expect(desc).not.toMatch(/^(a |an |the |pacer)/i);
  if (Bun.which("ruby")) { const ruby = spawnSync("ruby", ["-c", out], { encoding: "utf8" }); expect(ruby.status).toBe(0); expect(ruby.stdout).toContain("Syntax OK"); }
});
test("refuses partial and malformed manifests before writing a formula", () => {
  const { dir, release, out } = fixture(); writeRelease(dir, "2.3.4", [TARGETS[0]]);
  expect(generate(release, out).status).toBe(1); expect(existsSync(out)).toBe(false);
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ version: "2.3.4", assets: [{ os: "linux", arch: "x64", file: "../escape" }] }));
  expect(generate(release, out).stderr).toContain("invalid manifest");
});
