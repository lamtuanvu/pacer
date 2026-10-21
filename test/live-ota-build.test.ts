import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { fixtureCompileCommand, fixtureBuildEnvironment, copyFixtureSource, fixtureFeed, assertFixtureBundlePlist } from "../scripts/live/ota-build";

const policy = { schema: 1 as const, root: "/fixture/.work/live/test/ota", nonce: "a".repeat(32), home: "/fixture/.work/live/test/home", port: 49991, currentApp: "/fixture/.work/live/test/ota/current.app", serviceLabel: `com.pacer.live.${"a".repeat(32)}.service`, recoveryLabel: `com.pacer.live.${"a".repeat(32)}.recovery`, uid: process.getuid!() };
test.skipIf(process.platform !== "darwin")("fixture CLI command embeds exact policy with no production trust define", () => {
  const args = fixtureCompileCommand("/source", "/output/pacer", "0.2.4", policy);
  expect(args).toContain(`PACER_BUILD_OTA_FIXTURE=${JSON.stringify(JSON.stringify(policy))}`);
  expect(args.join(" ")).not.toContain("PACER_BUILD_APPLE_TEAM_ID");
  expect(args).toContain('PACER_BUILD_VERSION="0.2.4"');
  expect(() => fixtureCompileCommand("/source", "/output", "9.9.9", policy)).toThrow();
});
test("fixture build environment ignores production signing and runtime overrides", () => {
  const env = fixtureBuildEnvironment("/private", "public", policy, { PATH: "/bin", HOME: "/user", PACER_APPLE_TEAM_ID: "REALTEAM01", APPLE_SIGNING_IDENTITY: "real", TAURI_SIGNING_PRIVATE_KEY: "secret", PACER_BIN: "/foreign" });
  expect(env.PACER_OTA_PUBLIC_KEY).toBe("public");
  expect(env.PACER_OTA_FIXTURE_POLICY).toBe(JSON.stringify(policy));
  expect(env.HOME).toBe("/private");
  expect(env.RUSTC_WRAPPER).toBe("");
  expect(env.CARGO_BUILD_RUSTC_WRAPPER).toBe("");
  for (const key of ["PACER_APPLE_TEAM_ID", "APPLE_SIGNING_IDENTITY", "TAURI_SIGNING_PRIVATE_KEY", "PACER_BIN"]) expect(env[key]).toBeUndefined();
});
test("source snapshot changes only isolated version inputs and excludes live data", () => {
  const source = realpathSync(tmpDir()), destination = join(source, ".work/live/test/ota/build/candidate/source");
  mkdirSync(join(source, "desktop/src-tauri"), { recursive: true });
  mkdirSync(join(source, "src")); mkdirSync(join(source, ".work"));
  // Bundled plugins and workspace packages are compiled into the CLI.
  mkdirSync(join(source, "plugins")); mkdirSync(join(source, "packages/plugin-sdk"), { recursive: true });
  writeFileSync(join(source, "plugins/bundled.ts"), "export const BUNDLED = [];");
  writeFileSync(join(source, "packages/plugin-sdk/package.json"), "{}");
  writeFileSync(join(source, "bunfig.toml"), "[install]\n");
  writeFileSync(join(source, ".work/private"), "private");
  writeFileSync(join(source, ".env"), "never copy environment files");
  writeFileSync(join(source, "package.json"), JSON.stringify({ version: "0.2.3" }));
  writeFileSync(join(source, "desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.2.3", plugins: { "deep-link": { desktop: { schemes: ["pacer"] } } } }));
  writeFileSync(join(source, "desktop/src-tauri/Cargo.toml"), '[package]\nname = "pacer-desktop"\nversion = "0.2.3"\n');
  writeFileSync(join(source, "desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "pacer-desktop"\nversion = "0.2.3"\n');
  copyFixtureSource(source, destination, "0.2.4");
  expect(JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version).toBe("0.2.3");
  expect(JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).version).toBe("0.2.4");
  expect(JSON.parse(readFileSync(join(destination, "desktop/src-tauri/tauri.conf.json"), "utf8")).plugins["deep-link"]).toBeUndefined();
  expect(JSON.parse(readFileSync(join(source, "desktop/src-tauri/tauri.conf.json"), "utf8")).plugins["deep-link"].desktop.schemes).toEqual(["pacer"]);
  expect(readFileSync(join(destination, "desktop/src-tauri/Cargo.lock"), "utf8")).toContain('version = "0.2.4"');
  for (const path of ["plugins/bundled.ts", "packages/plugin-sdk/package.json", "bunfig.toml"]) expect(existsSync(join(destination, path))).toBe(true);
  expect(existsSync(join(destination, ".work"))).toBe(false);
  expect(existsSync(join(destination, ".env"))).toBe(false);
  expect(() => copyFixtureSource(source, source, "0.2.4")).toThrow();
  const diagnostic = join(source, ".work/live/test/ota/build/diagnostics/source");
  copyFixtureSource(source, diagnostic, "0.2.3");
  expect(JSON.parse(readFileSync(join(diagnostic, "package.json"), "utf8")).version).toBe("0.2.3");
  expect(() => copyFixtureSource(source, join(source, ".work/live/test/ota/build/arbitrary/source"), "0.2.3")).toThrow();
  copyFixtureSource(source, join(source, ".work/live/test/ota/build/diagnostics/source-2"), "0.2.3");
  expect(() => copyFixtureSource(source, join(source, ".work/live/test/ota/build/diagnostics/source-5"), "0.2.3")).toThrow();
});
test("fixture sources at any one stable release version become the synthetic baseline", () => {
  const make = (cargo: string) => {
    const source = realpathSync(tmpDir()), destination = join(source, ".work/live/test/ota/build/baseline/source");
    mkdirSync(join(source, "desktop/src-tauri"), { recursive: true }); mkdirSync(join(source, "src"));
    writeFileSync(join(source, "package.json"), JSON.stringify({ version: "0.5.0" }));
    writeFileSync(join(source, "desktop/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.5.0" }));
    writeFileSync(join(source, "desktop/src-tauri/Cargo.toml"), `[package]\nname = "pacer-desktop"\nversion = "${cargo}"\n`);
    writeFileSync(join(source, "desktop/src-tauri/Cargo.lock"), '[[package]]\nname = "pacer-desktop"\nversion = "0.5.0"\n');
    return { source, destination };
  };
  const ok = make("0.5.0");
  copyFixtureSource(ok.source, ok.destination, "0.2.3");
  expect(JSON.parse(readFileSync(join(ok.destination, "package.json"), "utf8")).version).toBe("0.2.3");
  expect(readFileSync(join(ok.destination, "desktop/src-tauri/Cargo.lock"), "utf8")).toContain('version = "0.2.3"');
  const mixed = make("0.4.0");
  expect(() => copyFixtureSource(mixed.source, mixed.destination, "0.2.3")).toThrow("Fixture native baseline changed");
});
test("host fixture feed preserves production URL and does not fabricate another architecture", () => {
  const feed = JSON.parse(fixtureFeed("aarch64", Buffer.from("archive"), "signature"));
  expect(Object.keys(feed.platforms)).toEqual(["darwin-aarch64"]);
  expect(feed.platforms["darwin-aarch64"].url).toBe("https://github.com/lamtuanvu/pacer/releases/download/v0.2.4/desktop-pacer-0.2.4-darwin-aarch64.app.tar.gz");
  expect(feed.version).toBe("0.2.4");
});

test("fixture bundle plist cannot advertise production URL handling", () => {
  const identity = "<key>CFBundleIdentifier</key><string>dev.pacer.desktop</string>";
  expect(() => assertFixtureBundlePlist(`<plist><dict>${identity}</dict></plist>`)).not.toThrow();
  expect(() => assertFixtureBundlePlist(`<plist><dict>${identity}<key>CFBundleURLTypes</key><array/></dict></plist>`)).toThrow();
});

test("fixture signing seals the native library before executable and app signatures", async () => {
  const module = await import("../scripts/live/ota-build");
  expect(typeof (module as any).signFixtureBundle).toBe("function");
  const calls: string[][] = [];
  await (module as any).signFixtureBundle("/fixture/pacer.app", "/fixture/entitlements.plist", async (argv: string[]) => { calls.push(argv); return ""; });
  expect(calls.filter(argv => argv.includes("--sign")).map(argv => [argv[argv.indexOf("--identifier") + 1], argv.at(-1)])).toEqual([
    ["dev.pacer.desktop.native-shim", "/fixture/pacer.app/Contents/Frameworks/libpacer-native.dylib"],
    ["dev.pacer.cli", "/fixture/pacer.app/Contents/Resources/pacer"],
    ["dev.pacer.desktop.update-helper", "/fixture/pacer.app/Contents/Resources/pacer-update-helper"],
    ["dev.pacer.desktop", "/fixture/pacer.app"],
  ]);
  expect(calls.at(-1)).toEqual(["/usr/bin/codesign", "--verify", "--deep", "--strict", "/fixture/pacer.app"]);
  const refused: string[][] = [];
  await expect((module as any).signFixtureBundle("/fixture/pacer.app", "/fixture/entitlements.plist", async (argv: string[]) => { refused.push(argv); throw Error("signer refused"); })).rejects.toThrow("signer refused");
  expect(refused).toHaveLength(1);
});

test("certificate-signed fixtures use the disposable identity for every component", async () => {
  const { signFixtureBundle } = await import("../scripts/live/ota-build");
  const calls: string[][] = [], signer = { sha1: "2C5405FB6D2906AE2049D59B9DF5D42661997922", keychain: "/fixture/signer.keychain-db" };
  await signFixtureBundle("/fixture/pacer.app", "/fixture/entitlements.plist", async argv => { calls.push(argv); return ""; }, signer);
  const signs = calls.filter(argv => argv.includes("--sign"));
  expect(signs).toHaveLength(4);
  for (const argv of signs) {
    expect(argv[argv.indexOf("--sign") + 1]).toBe(signer.sha1);
    expect(argv[argv.indexOf("--keychain") + 1]).toBe(signer.keychain);
    expect(argv).toContain("--timestamp=none");
  }
});
test("fixture lease carries the disposable certificate pin only for certificate-signed builds", async () => {
  const { otaFixturePolicy } = await import("../scripts/live/ota");
  const base = { root: "/r/.work/live/x/ota", nonce: "a".repeat(32), pacerHome: "/r/.work/live/x/home", innerPort: 7000, currentApp: "/r/.work/live/x/ota/current.app", serviceLabel: "s", recoveryLabel: "r", ownerUid: 501 };
  expect(otaFixturePolicy({ ...base, nativeFixture: { updaterKeySha256: "a".repeat(64) } } as any)).not.toHaveProperty("signingCertSha1");
  expect(otaFixturePolicy({ ...base, nativeFixture: { updaterKeySha256: "a".repeat(64), signingCertSha1: "A".repeat(40) } } as any).signingCertSha1).toBe("A".repeat(40));
});
test("fixture transport smoke requires actual verified ABI/version/architecture receipt", async () => {
  const module = await import("../scripts/live/ota-build");
  expect(typeof (module as any).assertFixtureTransport).toBe("function");
  const receipt = { schema: 1, role: "cli", version: "0.2.3", arch: "aarch64", nativeTransportAbi: 1, transport: "unix-audit-token", verified: true };
  expect(() => (module as any).assertFixtureTransport(receipt, "0.2.3", "aarch64")).not.toThrow();
  for (const changed of [{ verified: false }, { nativeTransportAbi: 2 }, { version: "0.2.4" }, { arch: "x86_64" }, { transport: "mock" }]) expect(() => (module as any).assertFixtureTransport({ ...receipt, ...changed }, "0.2.3", "aarch64")).toThrow();
});
