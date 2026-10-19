#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { command } from "./desktop-verify";
import { desktopAssetName, stableVersion, digest, type DesktopArch } from "./desktop-feed";
import { stageDesktopPackage, verifyNativeLibrary } from "./desktop";

interface SigningConfig { teamId: string; identity: string; keychain: string; notaryKey: string; notaryKeyId: string; notaryIssuer: string; signerKey: string; publicKey: string }
export function signingConfig(env: NodeJS.ProcessEnv = process.env): SigningConfig {
  const names = ["PACER_APPLE_TEAM_ID", "PACER_APPLE_SIGNING_IDENTITY", "PACER_SIGNING_KEYCHAIN", "PACER_NOTARY_KEY_PATH", "PACER_NOTARY_KEY_ID", "PACER_NOTARY_ISSUER", "TAURI_SIGNING_PRIVATE_KEY_PATH", "PACER_OTA_PUBLIC_KEY"] as const;
  if (names.some(name => !env[name])) throw Error("Production signing credentials are not configured");
  const [teamId, identity, keychain, notaryKey, notaryKeyId, notaryIssuer, signerKey, publicKey] = names.map(n => env[n]!);
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[a-fA-F0-9]{40}$/.test(identity) || !/^[A-Z0-9]{10}$/.test(notaryKeyId) || !/^[a-fA-F0-9-]{36}$/.test(notaryIssuer)) throw Error("Invalid production signing identity");
  return { teamId, identity, keychain, notaryKey, notaryKeyId, notaryIssuer, signerKey, publicKey };
}
type Run = (argv: string[], timeout?: number) => Promise<string>;
/** Operates only on a fresh complete staging copy. No credential discovery or unsigned fallback. */
export async function signStagedDesktop(o: { root: string; stage: string; out: string; version: string; arch: DesktopArch; config: SigningConfig }, run: Run = command): Promise<string> {
  stableVersion(o.version);
  const app = join(o.stage, "pacer.app"), resources = join(app, "Contents/Resources"), c = o.config;
  for (const path of [c.keychain, c.notaryKey, c.signerKey]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error("Signing inputs require private regular files");
  }
  // The fixed transport dylib is the only nested library; its signature precedes the CLI/app.
  for (const name of ["PlugIns", "XPCServices", "Helpers"]) if (existsSync(join(app, "Contents", name)) && readdirSync(join(app, "Contents", name)).length) throw Error("Unsupported nested signing payload");
  const frameworks = join(app, "Contents/Frameworks"), shim = join(frameworks, "libpacer-native.dylib");
  if (lstatSync(frameworks).isSymbolicLink() || readdirSync(frameworks).join() !== "libpacer-native.dylib" || !lstatSync(shim).isFile() || lstatSync(shim).isSymbolicLink()) throw Error("Unsupported nested signing payload");
  verifyNativeLibrary(readFileSync(shim), o.arch);
  const metadataPath = join(resources, "pacer-release.json"), metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.schema !== 1 || metadata.version !== o.version || metadata.arch !== o.arch || metadata.bundleId !== "dev.pacer.desktop" || metadata.admissionProtocol !== 1 || metadata.nativeTransportAbi !== 1 || metadata.rollbackCompatible !== true || JSON.stringify(metadata.protocolMajors) !== "[3]") throw Error("Desktop signing metadata mismatch");
  for (const [binary, role] of [[join(app, "Contents/MacOS/pacer"), "desktop"], [join(resources, "pacer-update-helper"), "update-helper"], [join(resources, "pacer"), "cli"]]) {
    const identity = JSON.parse(await run([binary, "--pacer-identity"]));
    if (identity.fixture !== false || identity.role !== role || identity.version !== o.version || identity.arch !== o.arch || identity.bundleId !== (role === "cli" ? "dev.pacer.cli" : "dev.pacer.desktop")) throw Error("Production signing requires production component identity");
    if (identity.otaMode !== "production" || identity.appleTeamId !== c.teamId || (role !== "cli" && identity.updaterKeySha256 !== digest(Buffer.from(c.publicKey)))) throw Error("Production signing requires matching compiled trust");
  }
  writeFileSync(metadataPath, JSON.stringify({ ...metadata, fixture: false }, null, 2) + "\n");
  const entitlements = join(o.stage, "cli-entitlements.plist");
  // Bun JSC requires allow-jit. Native transport uses the signed same-Team dylib;
  // runtime C compilation is forbidden. Library validation stays enabled.
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n', { mode: 0o600 });
  for (const [path, identifier, extra] of [[shim, "dev.pacer.desktop.native-shim", []], [join(resources, "pacer"), "dev.pacer.cli", ["--entitlements", entitlements]], [join(resources, "pacer-update-helper"), "dev.pacer.desktop.update-helper", []], [app, "dev.pacer.desktop", []]] as const) {
    await run(["/usr/bin/codesign", "--force", "--sign", c.identity, "--keychain", c.keychain, "--identifier", identifier, "--options", "runtime", "--timestamp", ...extra, path], 120_000);
  }
  await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
  // Smoke only native runner executables, after their final signatures.
  for (const binary of [join(resources, "pacer"), join(resources, "pacer-update-helper"), join(app, "Contents/MacOS/pacer")]) await run([binary, "--version"]);
  // Exercise the signed native transport under the final hardened signature on each native CI runner.
  const transport = JSON.parse(await run([join(resources, "pacer"), "--pacer-native-transport-test"]));
  if (transport.schema !== 1 || transport.role !== "cli" || transport.version !== o.version || transport.arch !== o.arch || transport.nativeTransportAbi !== 1 || transport.transport !== "unix-audit-token" || transport.verified !== true) throw Error("Signed native transport validation failed");
  const helper = JSON.parse(await run([join(resources, "pacer-update-helper"), "--pacer-helper-runtime-test"]));
  if (helper.schema !== 1 || helper.role !== "update-helper" || helper.version !== o.version || helper.arch !== o.arch || helper.runtime !== "tauri-updater" || helper.verified !== true) throw Error("Signed native helper runtime validation failed");
  const upload = join(o.stage, "notarization.zip");
  await run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, upload], 120_000);
  const receipt = JSON.parse(await run(["/usr/bin/xcrun", "notarytool", "submit", upload, "--key", c.notaryKey, "--key-id", c.notaryKeyId, "--issuer", c.notaryIssuer, "--wait", "--output-format", "json"], 1_800_000));
  if (receipt.status !== "Accepted" || typeof receipt.id !== "string" || !receipt.id) throw Error("Apple notarization was not accepted");
  await run(["/usr/bin/xcrun", "stapler", "staple", app], 120_000);
  await run(["/usr/bin/xcrun", "stapler", "validate", app]);
  await run(["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
  mkdirSync(o.out, { recursive: true });
  const artifact = join(o.out, desktopAssetName(o.version, o.arch));
  if (existsSync(artifact) || existsSync(artifact + ".sig")) throw Error("Refusing to overwrite a desktop artifact");
  await run(["/usr/bin/tar", "--format=ustar", "-czf", artifact, "-C", o.stage, "pacer.app"], 120_000);
  await run([process.execPath, join(o.root, "desktop/node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", "--private-key-path", c.signerKey, "--app-version", o.version, artifact], 120_000);
  return artifact;
}
if (import.meta.main) {
  try {
    const [dir, arch, out] = process.argv.slice(2);
    if (!dir || !out || !["aarch64", "x86_64"].includes(arch) || process.argv.length !== 5 || process.platform !== "darwin") throw Error("usage: desktop-sign.ts <release-dir> <aarch64|x86_64> <out-dir> (macOS production CI only)");
    const root = resolve(import.meta.dir, "../.."), config = signingConfig(), version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const stage = await stageDesktopPackage(root, resolve(dir), arch as DesktopArch);
    console.log(await signStagedDesktop({ root, stage, out: resolve(out), version, arch: arch as DesktopArch, config }));
  } catch (error) { console.error((error as Error).message); process.exit(1); }
}
