import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRelease } from "../scripts/release/build";
import { generateNpm } from "../scripts/release/npm";
import { generateHomebrew } from "../scripts/release/homebrew";
import { assetFile, companionFile, TARGETS } from "../src/update/manifest";
import { tmpDir } from "./helpers";

function fixture() {
  const root = tmpDir(), release = join(root, "0.8.0"); mkdirSync(release);
  for (const target of TARGETS) {
    writeFileSync(join(release, assetFile(target)), `front ${target.os}-${target.arch}`);
    writeFileSync(join(release, companionFile(target)), `core ${target.os}-${target.arch}`);
  }
  const manifest = writeRelease(root, "0.8.0", TARGETS, { paired: true });
  return { root, release, manifest };
}

test("npm platform packages contain verified executable front door and core", () => {
  const { root, release } = fixture(), out = join(root, "npm"); generateNpm(release, out);
  for (const target of TARGETS) {
    const dir = join(out, assetFile(target));
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).files).toEqual(["bin/pacer", "bin/pacer-core"]);
    expect(readFileSync(join(dir, "bin/pacer-core"), "utf8")).toBe(`core ${target.os}-${target.arch}`);
    for (const name of ["pacer", "pacer-core"]) expect(statSync(join(dir, "bin", name)).mode & 0o777).toBe(0o755);
  }
  expect(JSON.parse(readFileSync(join(out, "pacer/package.json"), "utf8")).bin).toEqual({ pacer: "bin/pacer.js" });
});

test("npm rejects corrupt companion bytes before writing packages", () => {
  const { root, release } = fixture(), out = join(root, "npm");
  writeFileSync(join(release, companionFile(TARGETS[2])), "corrupt");
  expect(() => generateNpm(release, out)).toThrow("checksum mismatch");
  expect(existsSync(out)).toBe(false);
});

test("Homebrew installs both verified resources beside each other with a front-door symlink", () => {
  const { root, release, manifest } = fixture(), out = join(root, "pacer.rb");
  generateHomebrew(join(release, "manifest.json"), out);
  const formula = readFileSync(out, "utf8");
  for (const asset of manifest.assets) {
    const core = asset.companions![0];
    expect(formula).toContain(`/v0.8.0/${core.file}`);
    expect(formula).toContain(`sha256 "${core.sha256}"`);
  }
  expect(formula).toContain('resource "pacer-core" do');
  expect(formula).toContain('libexec.install');
  expect(formula).toContain('bin.install_symlink libexec/"pacer"');
  if (Bun.which("ruby")) expect(Bun.spawnSync(["ruby", "-c", out]).exitCode).toBe(0);
});
