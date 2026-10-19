import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stageDesktopPackage } from "../scripts/release/desktop";
import { tmpDir } from "./helpers";

function fixture() {
  const root = tmpDir(), dir = join(root, "release");
  const app = join(dir, "pacer.app"), macos = join(app, "Contents/MacOS");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(app, "Contents/Resources"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const binary = Buffer.alloc(64);
  binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
  for (const file of [join(dir, "pacer-darwin-arm64"), join(dir, "pacer-update-helper"), join(macos, "pacer")]) {
    writeFileSync(file, binary); chmodSync(file, 0o755);
  }
  writeFileSync(join(app, "Contents/Info.plist"), '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string><key>CFBundleExecutable</key><string>pacer</string><key>CFBundleVersion</key><string>1.2.3</string><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>');
  const hash = createHash("sha256").update(binary).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "1.2.3", assets: [{ os: "darwin", arch: "arm64", file: "pacer-darwin-arm64", sha256: hash, size: binary.length }] }));
  writeFileSync(join(dir, "SHA256SUMS"), `${hash}  pacer-darwin-arm64\n`);
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return argv[0].endsWith("pacer-darwin-arm64") ? "pacer 1.2.3\n" : "1.2.3\n"; };
  return { root, dir, app, run, calls };
}

test("staging creates a separate complete app with matching release metadata and all executables", async () => {
  const f = fixture();
  const stage = await stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run });
  const app = join(stage, "pacer.app");
  expect(app).not.toBe(f.app);
  expect(readFileSync(join(app, "Contents/Resources/pacer"))).toEqual(readFileSync(join(f.dir, "pacer-darwin-arm64")));
  expect(readFileSync(join(app, "Contents/Resources/pacer-update-helper"))).toEqual(readFileSync(join(f.dir, "pacer-update-helper")));
  expect(JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8"))).toEqual({ schema: 1, bundleId: "dev.pacer.desktop", version: "1.2.3", arch: "aarch64", protocolMajors: [3], admissionProtocol: 1, rollbackCompatible: true });
  expect(f.calls.length).toBe(3);
  expect(f.calls.every(argv => argv.length === 2 && argv[1] === "--version")).toBe(true);
  expect(existsSync(join(f.app, "Contents/Resources/pacer-release.json"))).toBe(false);
});

test("staging refuses mismatched architecture before running a binary", async () => {
  const f = fixture();
  const bad = readFileSync(join(f.dir, "pacer-update-helper")); bad.writeUInt32LE(0x01000007, 4);
  writeFileSync(join(f.dir, "pacer-update-helper"), bad);
  await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run })).rejects.toThrow("architecture");
  expect(f.calls).toEqual([]);
});

test("staging refuses mismatched component versions and altered release checksums", async () => {
  const f = fixture();
  await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: async () => "1.2.2\n" })).rejects.toThrow("version");
  writeFileSync(join(f.dir, "pacer-darwin-arm64"), Buffer.alloc(64));
  await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run })).rejects.toThrow("checksum");
  expect(f.calls).toEqual([]);
});

test("staging refuses redirected bundle content and never writes through it", async () => {
  const f = fixture(), outside = tmpDir();
  symlinkSync(outside, join(f.app, "Contents/Resources/redirect"));
  await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run })).rejects.toThrow("symlink");
  expect(existsSync(join(outside, "pacer-release.json"))).toBe(false);
});
