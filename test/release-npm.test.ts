import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeRelease } from "../scripts/release/build";
import { TARGETS } from "../src/update/manifest";

const root = resolve(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-npm-")); dirs.push(dir);
  const release = join(dir, "1.2.3"); mkdirSync(release);
  for (const p of TARGETS) writeFileSync(join(release, `pacer-${p.os}-${p.arch}`), `binary ${p.os}-${p.arch}`);
  writeRelease(dir, "1.2.3", TARGETS);
  return { dir, release, out: join(dir, "npm") };
}
function generate(release: string, out: string) {
  return spawnSync(process.execPath, [join(root, "scripts/release/npm.ts"), "--release-dir", release, "--out", out], { encoding: "utf8" });
}
test("generates publishable platform packages and pinned launcher in publication order", () => {
  const { release, out } = fixture(); const result = generate(release, out);
  expect(result.status).toBe(0);
  const dependencies: Record<string, string> = {};
  for (const p of TARGETS) {
    const name = `pacer-${p.os}-${p.arch}`; dependencies[`@lamtuanvu/${name}`] = "1.2.3";
    const dir = join(out, name); const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg).toEqual({ name: `@lamtuanvu/${name}`, version: "1.2.3", description: expect.any(String), license: "Apache-2.0", repository: { type: "git", url: "git+https://github.com/lamtuanvu/pacer.git", directory: "npm" }, os: [p.os], cpu: [p.arch], files: ["bin/pacer"], publishConfig: { access: "public" } });
    expect(readFileSync(join(dir, "bin/pacer"), "utf8")).toBe(`binary ${p.os}-${p.arch}`);
    expect(statSync(join(dir, "bin/pacer")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("internal platform package");
    for (const file of ["LICENSE", "NOTICE"]) expect(readFileSync(join(dir, file))).toEqual(readFileSync(join(root, file)));
  }
  const pkg = JSON.parse(readFileSync(join(out, "pacer/package.json"), "utf8"));
  expect(pkg.name).toBe("@lamtuanvu/pacer"); expect(pkg.version).toBe("1.2.3");
  expect(pkg.bin).toEqual({ pacer: "bin/pacer.js" }); expect(pkg.optionalDependencies).toEqual(dependencies);
  expect(pkg.engines).toEqual({ node: ">=18" }); expect(pkg.scripts).toBeUndefined(); expect(pkg.private).toBeUndefined();
  expect(pkg.publishConfig).toEqual({ access: "public" });
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const key of ["keywords", "homepage", "bugs", "repository"]) expect(pkg[key]).toEqual(source[key]);
  for (const file of ["README.md", "LICENSE", "NOTICE"]) expect(readFileSync(join(out, "pacer", file))).toEqual(readFileSync(join(root, file)));
  expect(statSync(join(out, "pacer/bin/pacer.js")).mode & 0o777).toBe(0o755);
  expect(readFileSync(join(out, "publish-order.txt"), "utf8").trim().split("\n")).toEqual(["pacer-darwin-arm64", "pacer-darwin-x64", "pacer-linux-x64", "pacer-linux-arm64", "pacer"]);
});
test("refuses corrupted binaries before writing packages", () => {
  const { release, out } = fixture(); writeFileSync(join(release, "pacer-linux-x64"), "corrupted");
  const result = generate(release, out); expect(result.status).toBe(1); expect(result.stderr).toContain("checksum mismatch"); expect(existsSync(out)).toBe(false);
});
test("refuses incomplete or invalid manifests", () => {
  const { release, out } = fixture(); writeRelease(resolve(release, ".."), "1.2.3", [TARGETS[0]]);
  expect(generate(release, out).status).toBe(1);
  writeFileSync(join(release, "manifest.json"), JSON.stringify({ version: "bad", assets: [] }));
  expect(generate(release, out).stderr).toContain("invalid manifest");
});
function launcher(platform: string, arch: string, binary?: string, override?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pacer-launcher-")); dirs.push(dir);
  const script = join(dir, "pacer.cjs"); copyFileSync(join(root, "npm/launcher/bin/pacer.js"), script);
  if (binary) {
    const bin = join(dir, "node_modules", `@lamtuanvu/pacer-${platform}-${arch}`, "bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pacer"), binary); chmodSync(join(bin, "pacer"), 0o755);
  }
  const code = `Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}}); Object.defineProperty(process, 'arch', {value: ${JSON.stringify(arch)}}); process.argv = ['node', ${JSON.stringify(script)}, 'one two', '--flag']; require(${JSON.stringify(script)});`;
  return spawnSync("node", ["-e", code], { encoding: "utf8", env: { ...process.env, PACER_BINARY_PATH: override ?? "" } });
}
test("launcher resolves all platform packages, passes args and install hint, propagates exit", () => {
  for (const [os, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["linux", "x64"]]) {
    const result = launcher(os, arch, '#!/bin/sh\nprintf "%s\\n" "$PACER_INSTALL_METHOD" "$@"\nexit 7\n');
    expect(result.stdout).toBe("npm\none two\n--flag\n"); expect(result.status).toBe(7);
  }
});
test("launcher reports missing dependencies and unsupported platforms with alternatives", () => {
  for (const [os, arch] of [["linux", "x64"], ["win32", "x64"]]) {
    const result = launcher(os, arch); expect(result.status).toBe(1);
    expect(result.stderr).toContain(`@lamtuanvu/pacer-${os}-${arch}`); expect(result.stderr).toContain("install.sh"); expect(result.stderr).toContain("Homebrew");
  }
});
test("launcher honors an override even on unsupported hosts and handles spawn errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-override-")); dirs.push(dir); const bin = join(dir, "pacer");
  writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$PACER_INSTALL_METHOD" "$@"\n'); chmodSync(bin, 0o755);
  expect(launcher("win32", "x64", undefined, bin).stdout).toBe("npm\none two\n--flag\n");
  expect(launcher("linux", "x64", undefined, join(dir, "missing")).status).toBe(1);
});
test("launcher re-raises child termination signals", () => {
  const result = launcher("linux", "x64", '#!/bin/sh\nkill -TERM $$\n'); expect(result.signal).toBe("SIGTERM");
});
