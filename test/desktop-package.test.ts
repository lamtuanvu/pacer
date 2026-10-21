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
  mkdirSync(join(root, "src/update/desktop"), { recursive: true });
  writeFileSync(join(root, "src/update/desktop/native-socket.c"), "/* fixed test source */");
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); if (argv[0] === "/usr/bin/xcrun") { const library = Buffer.from(binary); library.writeUInt32LE(6, 12); writeFileSync(argv[argv.indexOf("-o") + 1], library, { mode: 0o755 }); return ""; } return argv[0].endsWith("pacer-darwin-arm64") ? "pacer 1.2.3\n" : "1.2.3\n"; };
  return { root, dir, app, run, calls };
}

test("staging creates a separate complete app with matching release metadata and all executables", async () => {
  const f = fixture();
  const stage = await stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run });
  const app = join(stage, "pacer.app");
  expect(app).not.toBe(f.app);
  expect(readFileSync(join(app, "Contents/Resources/pacer"))).toEqual(readFileSync(join(f.dir, "pacer-darwin-arm64")));
  expect(readFileSync(join(app, "Contents/Resources/pacer-update-helper"))).toEqual(readFileSync(join(f.dir, "pacer-update-helper")));
  expect(JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8"))).toEqual({ schema: 1, bundleId: "dev.pacer.desktop", version: "1.2.3", arch: "aarch64", protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true });
  expect(f.calls.filter(argv => argv[1] === "--version")).toHaveLength(3);
  expect(f.calls.find(argv => argv[0] === "/usr/bin/xcrun")).toContain("arm64-apple-macos11");
  expect(readFileSync(join(app, "Contents/Frameworks/libpacer-native.dylib")).readUInt32LE(12)).toBe(6);
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


test("staging rejects a compiler output with the wrong library architecture or Mach-O type", async () => {
  for (const field of [4, 12]) {
    const f = fixture();
    await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: async argv => {
      const result = await f.run(argv);
      if (argv[0] === "/usr/bin/xcrun") {
        const path = argv[argv.indexOf("-o") + 1], bytes = readFileSync(path);
        bytes.writeUInt32LE(field === 4 ? 0x01000007 : 2, field); writeFileSync(path, bytes);
      }
      return result;
    } })).rejects.toThrow("architecture/type");
  }
});

test("staging removes only the duplicate Cargo helper from its private copy", async () => {
  const f = fixture();
  const duplicate = join(f.app, "Contents/MacOS/pacer-update-helper");
  writeFileSync(duplicate, "duplicate Cargo output");
  const stage = await stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run });
  expect(existsSync(join(stage, "pacer.app/Contents/MacOS/pacer-update-helper"))).toBe(false);
  expect(readFileSync(duplicate, "utf8")).toBe("duplicate Cargo output");
  expect(readFileSync(join(stage, "pacer.app/Contents/Resources/pacer-update-helper"))).toEqual(readFileSync(join(f.dir, "pacer-update-helper")));
});

test("staging rejects unknown MacOS payloads and helper directories", async () => {
  const f = fixture();
  writeFileSync(join(f.app, "Contents/MacOS/unexpected"), "unknown executable");
  await expect(stageDesktopPackage(f.root, f.dir, "aarch64", { run: f.run })).rejects.toThrow("MacOS");
  const g = fixture();
  mkdirSync(join(g.app, "Contents/MacOS/pacer-update-helper"));
  await expect(stageDesktopPackage(g.root, g.dir, "aarch64", { run: g.run })).rejects.toThrow();
});
