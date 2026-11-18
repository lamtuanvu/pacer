import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildRelease, parseBuildArgs, writeRelease } from "../scripts/release/build";
import { type Platform, assetFile, companionFile, parseManifest, sha256Hex } from "../src/update/manifest";
import { tmpDir } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");

function fakeBinaries(outRoot: string, version: string, platforms: Platform[]): void {
  const dir = join(outRoot, version);
  mkdirSync(dir, { recursive: true });
  for (const p of platforms) {
    const f = join(dir, assetFile(p));
    writeFileSync(f, `#!/bin/sh\n# ${p.os}-${p.arch}\necho "pacer ${version}"\n`);
    chmodSync(f, 0o755);
    writeFileSync(join(dir, companionFile(p)), `#!/bin/sh\necho "pacer ${version}"\n`, { mode: 0o755 });
  }
}

test("writeRelease writes SHA256SUMS, manifest.json and latest.json for the built files", () => {
  const out = tmpDir();
  const plats: Platform[] = [{ os: "darwin", arch: "arm64" }, { os: "linux", arch: "x64" }];
  fakeBinaries(out, "0.3.0", plats);
  const m = writeRelease(out, "0.3.0", plats);
  const dir = join(out, "0.3.0");
  const a = readFileSync(join(dir, "pacer-darwin-arm64"));
  const b = readFileSync(join(dir, "pacer-linux-x64"));
  expect(m).toEqual({
    version: "0.3.0",
    assets: [
      { os: "darwin", arch: "arm64", file: "pacer-darwin-arm64", sha256: sha256Hex(a), size: a.length },
      { os: "linux", arch: "x64", file: "pacer-linux-x64", sha256: sha256Hex(b), size: b.length },
    ],
  });
  expect(parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")))).toEqual(m);
  expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe(`${sha256Hex(a)}  pacer-darwin-arm64\n${sha256Hex(b)}  pacer-linux-x64\n`);
  expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual({ version: "0.3.0" });
});

test("latest.json never moves back to an older version", () => {
  const out = tmpDir();
  const plats: Platform[] = [{ os: "linux", arch: "arm64" }];
  fakeBinaries(out, "0.3.0", plats);
  writeRelease(out, "0.3.0", plats);
  fakeBinaries(out, "0.2.5", plats);
  writeRelease(out, "0.2.5", plats);
  expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual({ version: "0.3.0" });
  fakeBinaries(out, "0.4.0-rc.1", plats);
  writeRelease(out, "0.4.0-rc.1", plats);
  expect(JSON.parse(readFileSync(join(out, "latest.json"), "utf8"))).toEqual({ version: "0.4.0-rc.1" });
});

test("parseBuildArgs reads --host, --out and --version and rejects the rest", () => {
  expect(parseBuildArgs([])).toEqual({ host: false });
  expect(parseBuildArgs(["--host", "--out", "/tmp/r", "--version", "0.2.0"])).toEqual({ host: true, out: "/tmp/r", version: "0.2.0" });
  expect(parseBuildArgs(["--out"])).toContain("--out needs a value");
  expect(parseBuildArgs(["--out", "--host"])).toContain("--out needs a value");
  expect(parseBuildArgs(["--all"])).toContain('unknown argument "--all"');
});

test("buildRelease rejects an invalid version before compiling anything", async () => {
  await expect(buildRelease({ root: ROOT, outRoot: tmpDir(), version: "1.0", targets: [] })).rejects.toThrow('invalid version "1.0"');
});

test("release CLI selects runner targets and can write metadata without rebuilding", () => {
  const parsed = parseBuildArgs(["--targets", "linux-x64,linux-arm64", "--write-only"]);
  expect(typeof parsed).toBe("object");
  if (typeof parsed !== "string") {
    expect(parsed.targets?.map(t => assetFile(t))).toEqual(["pacer-linux-x64", "pacer-linux-arm64"]);
    expect(parsed.writeOnly).toBe(true);
  }
  for (const names of ["windows-x64", "linux-x64,linux-x64", ""]) expect(parseBuildArgs(["--targets", names])).toContain("invalid --targets");
  expect(parseBuildArgs(["--host", "--targets", "linux-x64"])).toContain("cannot be combined");
  const out = tmpDir();
  const platforms: Platform[] = [{ os: "linux", arch: "x64" }, { os: "linux", arch: "arm64" }];
  fakeBinaries(out, "0.2.0", platforms);
  const r = Bun.spawnSync([process.execPath, "scripts/release/build.ts", "--write-only", "--out", out, "--version", "0.2.0", "--targets", "linux-x64,linux-arm64"], { cwd: ROOT });
  expect(r.exitCode).toBe(0);
  expect(parseManifest(JSON.parse(readFileSync(join(out, "0.2.0", "manifest.json"), "utf8"))).assets).toHaveLength(2);
});
