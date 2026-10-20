/** Explicit native fixture builder. No production credential or service-manager path. */
import { chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { checkout } from "./core";
import { finishOtaBuild, otaFixturePolicy, readOtaRecord, reserveOtaBuild } from "./ota";
import { compileCommand, writeRelease } from "../release/build";
import { stageDesktopPackage, verifyDesktopExecutable } from "../release/desktop";
import { desktopAssetName, digest, verifyUpdateSignature, type DesktopArch } from "../release/desktop-feed";
import { inspectDesktopArchive } from "../release/desktop-verify";
import { assetFile, hostTarget } from "../../src/update/manifest";
import { parsePlistDictionary } from "../../src/service";
import { parseNativeFixture, type NativeFixture } from "../../src/update/desktop/native-fixture";

const versions = ["0.2.3", "0.2.4"] as const;
function fixtureVersion(version: string): void { if (!(versions as readonly string[]).includes(version)) throw Error("Unsupported fixture version"); }
export function fixtureCompileCommand(root: string, outfile: string, version: string, policy: NativeFixture): string[] {
  fixtureVersion(version); parseNativeFixture(JSON.stringify(policy));
  const target = hostTarget();
  if (!target || target.os !== "darwin") throw Error("Native OTA fixtures require macOS");
  return [...compileCommand({ root, outfile, version, target }), "--define", `PACER_BUILD_OTA_FIXTURE=${JSON.stringify(JSON.stringify(policy))}`];
}
export function fixtureBuildEnvironment(home: string, publicKey: string, policy: NativeFixture, inherited: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return { PATH: inherited.PATH, HOME: home, CI: "true", COPYFILE_DISABLE: "1", CARGO_NET_OFFLINE: "true", RUSTC_WRAPPER: "", CARGO_BUILD_RUSTC_WRAPPER: "", CARGO_HOME: inherited.CARGO_HOME ?? join(inherited.HOME ?? homedir(), ".cargo"), RUSTUP_HOME: inherited.RUSTUP_HOME ?? join(inherited.HOME ?? homedir(), ".rustup"), PACER_OTA_PUBLIC_KEY: publicKey, PACER_OTA_FIXTURE_POLICY: JSON.stringify(policy) };
}
/** Snapshot source only. Symlinks are limited to readonly dependency lookup roots after copying. */
export function copyFixtureSource(source: string, destination: string, version: string): void {
  fixtureVersion(version); source = realpathSync(source); destination = resolve(destination);
  const part = relative(source, destination);
  if (!/^\.work\/live\/[a-zA-Z0-9_-]+\/ota\/build\/(?:(baseline|candidate)\/source|diagnostics\/source(?:-[234])?)$/.test(part) || existsSync(destination)) throw Error("Fixture source destination is not a fresh reserved build path");
  for (let parent = dirname(destination); parent !== source; parent = dirname(parent)) if (existsSync(parent) && realpathSync(parent) !== parent) throw Error("Fixture refuses symlinked build parents");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const excluded = new Set(["node_modules", "target", "dist"]);
  const roots = new Set(["src", "app", "desktop", "orca-plugin", "scripts", "package.json", "bun.lock", "tsconfig.json"]);
  const filter = (path: string) => {
    const parts = relative(source, path).split("/");
    if (!roots.has(parts[0]) || parts.some(name => name.startsWith(".") || excluded.has(name))) return false;
    if (lstatSync(path).isSymbolicLink()) throw Error("Fixture source snapshot refuses symlinks");
    return true;
  };
  mkdirSync(destination, { mode: 0o700 });
  for (const name of readdirSync(source)) if (filter(join(source, name))) cpSync(join(source, name), join(destination, name), { recursive: true, dereference: false, filter });
  // Fixtures always run at the synthetic baseline/candidate versions; the checkout's own
  // version only has to be one stable version shared by every package identity.
  const current = JSON.parse(readFileSync(join(destination, "package.json"), "utf8")).version;
  if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) throw Error("Fixture source version is not a stable release version");
  const escaped = current.replaceAll(".", "\\.");
  for (const path of ["package.json", "desktop/src-tauri/tauri.conf.json"]) {
    const file = join(destination, path), value = JSON.parse(readFileSync(file, "utf8"));
    if (value.version !== current) throw Error("Fixture source baseline version changed");
    value.version = version;
    if (path === "desktop/src-tauri/tauri.conf.json" && value.plugins) delete value.plugins["deep-link"];
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  }
  for (const name of ["Cargo.toml", "Cargo.lock"]) {
    const file = join(destination, "desktop/src-tauri", name), text = readFileSync(file, "utf8");
    const pattern = name === "Cargo.toml" ? /(^\[package\]\s*\n)([^]*?)(?=^\[|$(?![^]))/gm : /(^\[\[package\]\]\s*\n)([^]*?)(?=^\[\[|$(?![^]))/gm;
    let count = 0;
    const next = text.replace(pattern, (all, header: string, body: string) => {
      if (!/^name = "pacer-desktop"$/m.test(body)) return all;
      const pinned = new RegExp(`^version = "${escaped}"$`, "m");
      if (!pinned.test(body)) throw Error("Fixture native baseline changed");
      count++; return header + body.replace(pinned, `version = "${version}"`);
    });
    if (count !== 1) throw Error("Fixture native package identity missing");
    writeFileSync(file, next);
  }
  for (const path of ["node_modules", "desktop/node_modules"]) if (existsSync(join(source, path))) symlinkSync(realpathSync(join(source, path)), join(destination, path));
}
export function fixtureFeed(arch: DesktopArch, archive: Buffer, signature: string): string {
  if (!["aarch64", "x86_64"].includes(arch) || signature.length > 8192) throw Error("Invalid host fixture feed");
  const version = "0.2.4", name = desktopAssetName(version, arch);
  return JSON.stringify({ schema: 1, version, notes: "Disposable native OTA validation fixture", pub_date: new Date().toISOString(), platforms: {
    [`darwin-${arch}`]: { url: `https://github.com/lamtuanvu/pacer/releases/download/v${version}/${name}`, signature, sha256: digest(archive), bundleId: "dev.pacer.desktop", protocolMajors: [3], admissionProtocol: 1, rollbackCompatible: true },
  } }, null, 2) + "\n";
}

export function assertFixtureBundlePlist(text: string): void {
  const value = parsePlistDictionary(text);
  if (value.CFBundleIdentifier !== "dev.pacer.desktop" || Object.hasOwn(value, "CFBundleURLTypes")) throw Error("Fixture bundle must not register production URL handling");
}

export function assertFixtureTransport(value: unknown, version: string, arch: DesktopArch): void {
  const receipt = value as Record<string, unknown> | null;
  if (!receipt || receipt.schema !== 1 || receipt.role !== "cli" || receipt.version !== version || receipt.arch !== arch || receipt.nativeTransportAbi !== 1 || receipt.transport !== "unix-audit-token" || receipt.verified !== true) throw Error("Fixture signed native transport validation failed");
}

export type FixtureSigner = { sha1: string; keychain: string };
/** Sign nested native code before sealing the app envelope. A refusal stops the sequence. */
export async function signFixtureBundle(app: string, entitlement: string, run: (argv: string[]) => Promise<string>, signer?: FixtureSigner): Promise<void> {
  const resources = join(app, "Contents/Resources");
  const identity = signer ? ["--sign", signer.sha1, "--keychain", signer.keychain, "--timestamp=none"] : ["--sign", "-"];
  for (const [file, identifier, extra] of [
    [join(app, "Contents/Frameworks/libpacer-native.dylib"), "dev.pacer.desktop.native-shim", []],
    [join(resources, "pacer"), "dev.pacer.cli", ["--entitlements", entitlement]],
    [join(resources, "pacer-update-helper"), "dev.pacer.desktop.update-helper", []],
    [app, "dev.pacer.desktop", []],
  ] as const) await run(["/usr/bin/codesign", "--force", ...identity, "--identifier", identifier, ...extra, file]);
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
}
/** Disposable code-signing identity in a private keychain; it mirrors an interim release certificate. */
async function createFixtureSigner(directory: string, run: (argv: string[], cwd?: string, quiet?: boolean) => Promise<string>): Promise<FixtureSigner> {
  const p = (name: string) => join(directory, name), keychain = p("fixture-signer.keychain-db"), password = randomBytes(16).toString("hex");
  writeFileSync(p("signer.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=pacer live fixture signing\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n", { mode: 0o600 });
  await run(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "7", "-keyout", p("signer.key"), "-out", p("signer.pem"), "-config", p("signer.cnf")], directory, true);
  await run(["/usr/bin/openssl", "pkcs12", "-export", "-inkey", p("signer.key"), "-in", p("signer.pem"), "-out", p("signer.p12"), "-passout", `pass:${password}`], directory, true);
  await run(["/usr/bin/security", "create-keychain", "-p", password, keychain], directory, true);
  // A new keychain locks after five idle minutes; a slow build reaches signing later than that.
  await run(["/usr/bin/security", "set-keychain-settings", "-t", "21600", keychain], directory, true);
  await run(["/usr/bin/security", "unlock-keychain", "-p", password, keychain], directory, true);
  await run(["/usr/bin/security", "import", p("signer.p12"), "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"], directory, true);
  await run(["/usr/bin/security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain], directory, true);
  const sha1 = (await run(["/usr/bin/openssl", "x509", "-noout", "-fingerprint", "-sha1", "-in", p("signer.pem")], directory, true)).trim().split("=").at(-1)!.replaceAll(":", "").toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(sha1)) throw Error("Fixture signer fingerprint unavailable");
  return { sha1, keychain };
}

/** This entry point accepts only a harness session ID. All commands, versions and outputs are fixed. */
export async function buildOtaFixtures(id: string, signerMode: "adhoc" | "cert" = "adhoc"): Promise<void> {
  if (process.platform !== "darwin") throw Error("Native fixtures require macOS");
  const target = hostTarget(); if (!target || target.os !== "darwin") throw Error("Unsupported fixture host");
  const arch: DesktopArch = target.arch === "arm64" ? "aarch64" : "x86_64";
  // Guard the lease before even invoking the disposable signer. No fixture can replace an existing record.
  const { loadSession, liveRoot } = await import("./core");
  const session = loadSession(id), root = join(session.root, "ota");
  if (existsSync(root) || realpathSync(session.root) !== session.root || session.seed || session.stopped || !session.innerPort) throw Error("Fixture requires a fresh unseeded live sandbox");
  for (const path of [liveRoot, session.root, join(session.root, "home"), join(session.root, "evidence")]) {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || realpathSync(path) !== path) throw Error("Fixture requires private canonical ownership");
  }
  const temporary = mkdtempSync(join(session.root, ".ota-key-")); chmodSync(temporary, 0o700);
  const cli = join(checkout, "desktop/node_modules/@tauri-apps/cli/tauri.js"), key = join(temporary, "fixture.key");
  let environment: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: temporary, CI: "true", COPYFILE_DISABLE: "1" };
  let signer: FixtureSigner | undefined;
  async function run(argv: string[], cwd = checkout, quiet = false): Promise<string> {
    const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (!quiet) process.stderr.write(stderr);
    if (code !== 0) throw Error(`Fixture command failed: ${argv[0]} ${argv[1]} (exit ${code})`);
    return stdout;
  }
  try {
    if ((await run([process.execPath, cli, "--version"], checkout, true)).trim() !== "tauri-cli 2.12.3") throw Error("Pinned Tauri signer is unavailable");
    await run([process.execPath, cli, "signer", "generate", "--ci", "--password", "disposable-fixture", "--write-keys", key], checkout, true);
    chmodSync(key, 0o600);
    // The certificate pin is compiled into the lease, so its identity must exist before any build.
    signer = signerMode === "cert" ? await createFixtureSigner(temporary, run) : undefined;
    const publicKey = readFileSync(key + ".pub", "utf8").trim(), state = reserveOtaBuild(id, arch, digest(Buffer.from(publicKey)), {}, signer?.sha1), policy = otaFixturePolicy(state);
    const build = state.nativeFixture!.buildRoot, home = join(build, "home"), targetDir = join(build, "target"); mkdirSync(home, { mode: 0o700 });
    // An optional local Cargo seed avoids recompiling unchanged dependencies.
    // Each build receives an independent copy; Cargo rechecks source/env inputs,
    // and the normal signature + compiled-lease checks still gate every bundle.
    const cache = join(checkout, ".work/cache/desktop-ota-target");
    if (existsSync(cache)) {
      for (const path of [join(checkout, ".work"), dirname(cache), cache]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || realpathSync(path) !== path) throw Error("Fixture Cargo cache must be private and canonical");
      }
      cpSync(cache, targetDir, { recursive: true, dereference: false, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE });
    }
    environment = { ...fixtureBuildEnvironment(home, publicKey, policy), CARGO_TARGET_DIR: targetDir };
    for (const [index, version] of versions.entries()) copyFixtureSource(checkout, join(build, index === 0 ? "baseline" : "candidate", "source"), version);
    const snapshotDigest = (root: string) => {
      const hash = createHash("sha256");
      const walk = (path: string): void => {
        const name = relative(root, path), stat = lstatSync(path);
        if (["node_modules", "desktop/node_modules"].includes(name)) return;
        hash.update(JSON.stringify([name, stat.mode & 0o777]));
        if (stat.isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child));
        else if (stat.isFile()) hash.update(readFileSync(path));
        else throw Error("Unexpected source snapshot resource");
      };
      walk(root); return hash.digest("hex");
    };
    writeFileSync(join(session.root, "evidence/source-snapshot.json"), JSON.stringify({ schema: 1, scope: "managed-update-only", at: new Date().toISOString(), versions: versions.map((version, index) => ({ version, sha256: snapshotDigest(join(build, index === 0 ? "baseline" : "candidate", "source")) })) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    process.stderr.write("OTA fixture source snapshots captured for both versions.\n");
    for (const [index, version] of versions.entries()) {
      readOtaRecord(id); // Refuse changed lease before every build stage.
      const directory = join(build, index === 0 ? "baseline" : "candidate"), source = join(directory, "source"), release = join(directory, "release", version);
      mkdirSync(release, { recursive: true, mode: 0o700 });
      for (const script of ["plugin:build", "app:build"]) await run([process.execPath, "run", script], source);
      await run(fixtureCompileCommand(source, join(release, assetFile(target)), version, policy), source);
      writeRelease(join(directory, "release"), version, [target]);
      await run([process.execPath, cli, "build", "--bundles", "app", "--no-sign", "--features", "ota-fixture", "--", "--offline", "--locked"], join(source, "desktop"));
      await run(["cargo", "build", "--offline", "--locked", "--release", "--features", "ota-fixture", "--bin", "pacer-update-helper"], join(source, "desktop/src-tauri"));
      cpSync(join(targetDir, "release/bundle/macos/pacer.app"), join(release, "pacer.app"), { recursive: true });
      copyFileSync(join(targetDir, "release/pacer-update-helper"), join(release, "pacer-update-helper")); chmodSync(join(release, "pacer-update-helper"), 0o755);
      const stage = await stageDesktopPackage(source, release, arch, { run: argv => run(argv) }), app = join(stage, "pacer.app"), resources = join(app, "Contents/Resources");
      assertFixtureBundlePlist(readFileSync(join(app, "Contents/Info.plist"), "utf8"));
      const metadataPath = join(resources, "pacer-release.json"), metadata = JSON.parse(readFileSync(metadataPath, "utf8")); metadata.fixture = true; writeFileSync(metadataPath, JSON.stringify(metadata) + "\n");
      const entitlement = join(directory, "cli-entitlements.plist"); writeFileSync(entitlement, '<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>', { mode: 0o600 });
      await signFixtureBundle(app, entitlement, argv => run(argv), signer);
      for (const binary of [join(resources, "pacer"), join(resources, "pacer-update-helper"), join(app, "Contents/MacOS/pacer")]) {
        verifyDesktopExecutable(readFileSync(binary), arch);
        const identity = JSON.parse(await run([binary, "--pacer-identity"]));
        if (binary === join(app, "Contents/MacOS/pacer") && identity.fixtureIsolationProtocol !== 1) throw Error("Fixture shell lacks compile-time isolation proof");
        if (identity.version !== version || identity.arch !== arch || identity.fixture !== true || identity.otaMode !== "fixture" || identity.fixturePolicySha256 !== digest(Buffer.from(JSON.stringify(policy))) || (binary !== join(resources, "pacer") && identity.updaterKeySha256 !== state.nativeFixture!.updaterKeySha256)) throw Error("Fixture compiled identity differs from its lease");
      }
      renameSync(app, state.sources[index].path);
    }
    const archivePath = join(build, desktopAssetName("0.2.4", arch));
    await run(["/usr/bin/tar", "--format", "ustar", "-czf", archivePath, "-C", dirname(state.sources[1].path), "pacer.app"]);
    await run([process.execPath, cli, "signer", "sign", "--private-key-path", key, "--password", "disposable-fixture", "--app-version", "0.2.4", archivePath], checkout, true);
    const archive = readFileSync(archivePath), signature = readFileSync(archivePath + ".sig", "utf8").trim();
    verifyUpdateSignature(archive, signature, publicKey, "0.2.4");
    await inspectDesktopArchive(archive, async app => {
      const metadata = JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8"));
      if (metadata.version !== "0.2.4" || metadata.arch !== arch || metadata.fixture !== true) throw Error("Fixture archive metadata mismatch");
      await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
    });
    finishOtaBuild(id, { archive, feed: Buffer.from(fixtureFeed(arch, archive, signature)) });
    // Runtime authority requires a complete prepared lease, even for a self-test.
    for (const [index, version] of versions.entries()) {
      assertFixtureTransport(JSON.parse(await run([join(state.sources[index].path, "Contents/Resources/pacer"), "--pacer-native-transport-test"])), version, arch);
      const helper = JSON.parse(await run([join(state.sources[index].path, "Contents/Resources/pacer-update-helper"), "--pacer-helper-runtime-test"]));
      if (helper.schema !== 1 || helper.role !== "update-helper" || helper.version !== version || helper.arch !== arch || helper.runtime !== "tauri-updater" || helper.verified !== true) throw Error("Fixture native helper runtime validation failed");
    }
  } finally {
    if (signer) Bun.spawnSync(["/usr/bin/security", "delete-keychain", signer.keychain]);
    rmSync(temporary, { recursive: true, force: true });
  }
}
