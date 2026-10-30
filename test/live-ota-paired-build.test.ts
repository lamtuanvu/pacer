import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import * as build from "../scripts/live/ota-build";

const policy = { schema: 1 as const, root: "/fixture/.work/live/test/ota", nonce: "a".repeat(32), home: "/fixture/.work/live/test/home", port: 49991, currentApp: "/fixture/.work/live/test/ota/current.app", serviceLabel: `com.pacer.live.${"a".repeat(32)}.service`, recoveryLabel: `com.pacer.live.${"a".repeat(32)}.recovery`, uid: process.getuid!(), signingCertSha1: "A".repeat(40) };

test("bridge source commands pin the published bridge commit and reject unsafe selected tree entries", () => {
  expect((build as any).PUBLISHED_BRIDGE_SOURCE).toBe("9205c94ce0b32efd797e4892e56cdc374de01212");
  expect(typeof (build as any).assertPublishedBridgeTree).toBe("function");
  const safe = `100644 blob ${"a".repeat(40)}\tsrc/cli.ts\0`;
  expect(() => (build as any).assertPublishedBridgeTree(safe)).not.toThrow();
  for (const entry of [safe.replace("100644", "120000"), safe.replace("100644", "160000"), safe.replace("src/cli.ts", "src/../escape")]) {
    expect(() => (build as any).assertPublishedBridgeTree(entry)).toThrow();
  }
});

test("candidate source includes Rust workspace and excludes stale local sidecars", () => {
  const source = realpathSync(tmpDir()), destination = join(source, ".work/live/test/ota/build/candidate/source");
  mkdirSync(join(source, "desktop/src-tauri/binaries"), { recursive: true });
  mkdirSync(join(source, "crates/pacer/src"), { recursive: true });
  mkdirSync(join(source, "xtask/src"), { recursive: true });
  mkdirSync(join(source, ".cargo"));
  writeFileSync(join(source, "package.json"), '{"version":"0.7.1"}');
  writeFileSync(join(source, "desktop/src-tauri/tauri.conf.json"), '{"version":"0.7.1"}');
  writeFileSync(join(source, "desktop/src-tauri/Cargo.toml"), '[package]\nname = "pacer-desktop"\nversion = "0.7.1"\n');
  writeFileSync(join(source, "desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "pacer-desktop"\nversion = "0.7.1"\n');
  for (const path of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "crates/pacer/src/main.rs", "xtask/src/main.rs"]) writeFileSync(join(source, path), "workspace fixture");
  writeFileSync(join(source, "desktop/src-tauri/binaries/pacer-aarch64-apple-darwin"), "stale installed binary");
  build.copyFixtureSource(source, destination, "0.2.4");
  for (const path of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "crates/pacer/src/main.rs", "xtask/src/main.rs"]) expect(readFileSync(join(destination, path), "utf8")).toBe("workspace fixture");
  expect(existsSync(join(destination, "desktop/src-tauri/binaries"))).toBe(false);
  expect(readFileSync(join(destination, "desktop/src-tauri/Cargo.toml"), "utf8")).toContain("[workspace]");
  expect(readFileSync(join(source, "desktop/src-tauri/Cargo.toml"), "utf8")).not.toContain("[workspace]");
  const bad = join(source, ".work/live/test/ota/build/diagnostics/source");
  symlinkSync(join(source, "Cargo.toml"), join(source, "crates/redirected"));
  expect(() => build.copyFixtureSource(source, bad, "0.2.3")).toThrow("symlinks");
});

test.skipIf(process.platform !== "darwin")("candidate Rust build receives only explicit lease certificate pins", () => {
  const command = (build as any).fixtureFrontDoorBuild("/snapshot", "/private-target", "0.2.4", policy, { PATH: "/bin", PACER_BUILD_APPLE_TEAM_ID: "FOREIGN1234", PACER_BUILD_SIGNING_CERT_SHA1: "B".repeat(40), BUN_OPTIONS: "--preload evil" });
  expect(command.argv).toContain("--locked");
  expect(command.env.PACER_BUILD_SIGNING_CERT_SHA1).toBe(policy.signingCertSha1);
  expect(command.env.PACER_BUILD_APPLE_TEAM_ID).toBe("");
  expect(command.env.CARGO_TARGET_DIR).toBe("/private-target");
  expect(command.env.PACER_BUILD_DESKTOP_FIXTURE).toBe("1");
  expect(command.env.BUN_OPTIONS).toBeUndefined();
  expect(() => (build as any).fixtureFrontDoorBuild("/s", "/t", "0.2.4", { ...policy, signingCertSha1: undefined })).toThrow();
});

test("paired certificate fixtures seal core before root and include the declared permission helper", async () => {
  const app = join(realpathSync(tmpDir()), "pacer.app"), resources = join(app, "Contents/Resources"), macos = join(app, "Contents/MacOS");
  mkdirSync(resources, { recursive: true }); mkdirSync(macos, { recursive: true });
  writeFileSync(join(resources, "pacer-core"), "core", { mode: 0o700 });
  writeFileSync(join(macos, "pacer-permission-setup"), "helper", { mode: 0o700 });
  const calls: string[][] = [];
  await build.signFixtureBundle(app, "/entitlements", async argv => { calls.push(argv); return ""; }, { sha1: policy.signingCertSha1, keychain: "/private/keychain" });
  const signs = calls.filter(argv => argv.includes("--sign"));
  expect(signs.map(argv => argv.at(-1))).toEqual([join(app, "Contents/Frameworks/libpacer-native.dylib"), join(resources, "pacer-core"), join(resources, "pacer"), join(resources, "pacer-update-helper"), join(macos, "pacer-permission-setup"), app]);
  for (const argv of signs) {
    expect(argv).not.toContain("runtime");
    expect(argv).not.toContain("--entitlements");
  }
});
