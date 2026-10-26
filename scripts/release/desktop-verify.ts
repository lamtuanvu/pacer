import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { signerRequirement, type SignerPins } from "../../src/update/desktop/signer-requirement";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parsePlistDictionary } from "../../src/service";
import { verifyDesktopExecutable, verifyNativeLibrary } from "./desktop";
import { validateDesktopTar } from "./desktop-tar";
import type { DesktopArch, VerifiedDesktopApp } from "./desktop-feed";

export async function command(argv: string[], timeoutMs = 30_000): Promise<string> {
  const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1", TAURI_SIGNING_PRIVATE_KEY: undefined, PACER_APPLE_CERTIFICATE_BASE64: undefined, PACER_APPLE_CERTIFICATE_PASSWORD: undefined, PACER_NOTARY_KEY: undefined } });
  const timeout = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code) {
      // codesign handles public identities and paths; credential-bearing security commands stay opaque.
      const detail = argv[0] === "/usr/bin/codesign" ? ` (exit ${code}): ${stderr.trim().slice(0, 2000)}` : "";
      throw Error(`Desktop verification failed: ${argv[0]} ${argv[1]}${detail}`);
    }
    return stdout + stderr;
  } finally { clearTimeout(timeout); }
}
function plainTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error("Unsupported signed app resource");
  if (stat.isDirectory()) for (const name of readdirSync(path)) plainTree(join(path, name));
}
/** Content identity of an extracted app: relative paths, kinds, executable bits and file digests. */
export function appTreeDigest(app: string): string {
  const hash = createHash("sha256");
  const walk = (path: string, relative: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error("Unsupported signed app resource");
    // Length-prefixed JSON records keep the encoding unambiguous for any file name.
    const record = (value: unknown[]) => { const text = JSON.stringify(value); hash.update(`${Buffer.byteLength(text)}:${text}`); };
    if (stat.isFile()) { record(["f", relative, (stat.mode & 0o111) !== 0, createHash("sha256").update(readFileSync(path)).digest("hex")]); return; }
    record(["d", relative]);
    for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name);
  };
  walk(app, "");
  return hash.digest("hex");
}
/** Signature already verified by caller before archive parsing. Extraction is private and bounded. */
export async function inspectDesktopArchive<T>(bytes: Uint8Array, inspect: (app: string) => Promise<T>): Promise<T> {
  const tar = gunzipSync(bytes, { maxOutputLength: 1024 * 1024 * 1024 });
  validateDesktopTar(tar);
  const archive = new Bun.Archive(tar);
  const directory = mkdtempSync(join(tmpdir(), "pacer-release-verify-"));
  try {
    await archive.extract(directory);
    if (readdirSync(directory).join() !== "pacer.app") throw Error("Desktop archive contains unexpected roots");
    const app = join(directory, "pacer.app"); plainTree(app);
    return await inspect(app);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export const DISK_IMAGE_IDENTIFIER = "dev.pacer.desktop.disk-image";
/** Mounts a private copy read-only. The volume holds exactly pacer.app and the /Applications drop link. */
export async function inspectDesktopDiskImage<T>(bytes: Uint8Array, inspect: (app: string, image: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "pacer-release-image-")), image = join(directory, "pacer.dmg"), mount = join(directory, "volume");
  let attaching = false;
  try {
    writeFileSync(image, bytes, { mode: 0o600, flag: "wx" }); mkdirSync(mount, { mode: 0o700 });
    await command(["/usr/bin/hdiutil", "verify", "-quiet", image], 300_000);
    // Set before attach: a failed or timed-out attach may still have mounted the volume.
    attaching = true;
    await command(["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-quiet", "-mountpoint", mount, image], 300_000);
    if (readdirSync(mount).sort().join() !== "Applications,pacer.app") throw Error("Desktop disk image contains unexpected roots");
    const link = join(mount, "Applications");
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "/Applications") throw Error("Desktop disk image has an invalid Applications link");
    const app = join(mount, "pacer.app"); plainTree(app);
    return await inspect(app, image);
  } finally {
    // A mounted volume differs from its mount point's parent device.
    const mounted = () => { try { return lstatSync(mount).dev !== lstatSync(directory).dev; } catch { return false; } };
    if (attaching && mounted()) {
      await command(["/usr/bin/hdiutil", "detach", "-quiet", mount], 120_000).catch(() => command(["/usr/bin/hdiutil", "detach", "-force", "-quiet", mount], 120_000)).catch(() => undefined);
    }
    // Never recurse into a volume that is still mounted; report the leftover instead.
    if (attaching && mounted()) console.error(`Desktop disk image remains mounted at ${mount}`);
    else rmSync(directory, { recursive: true, force: true });
  }
}
const SIGNED_COMPONENTS = [["Contents/MacOS/pacer", "dev.pacer.desktop"], ["Contents/Resources/pacer", "dev.pacer.cli"], ["Contents/Resources/pacer-update-helper", "dev.pacer.desktop.update-helper"], ["Contents/Frameworks/libpacer-native.dylib", "dev.pacer.desktop.native-shim"]] as const;
/**
 * Signature checks for one extracted app. Any compiled certificate pin means the
 * archive is an interim (or bridge) release: each component must satisfy the
 * exact designated requirement, and there is no notarization to validate.
 * Developer ID releases keep stapler and Gatekeeper assessment.
 */
export function signedAppChecks(app: string, pins: SignerPins): string[][] {
  const checks: string[][] = [["/usr/bin/codesign", "--verify", "--deep", "--strict", app]];
  for (const [file, identifier] of SIGNED_COMPONENTS) checks.push(["/usr/bin/codesign", "--verify", "--strict", `-R=${signerRequirement(identifier, pins)}`, join(app, file)]);
  if (!pins.signingCertSha1) checks.push(["/usr/bin/xcrun", "stapler", "validate", app], ["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
  return checks;
}
async function verifyApp(app: string, arch: DesktopArch, pins: SignerPins): Promise<VerifiedDesktopApp> {
  for (const [file] of SIGNED_COMPONENTS) (file.endsWith(".dylib") ? verifyNativeLibrary : verifyDesktopExecutable)(readFileSync(join(app, file)), arch);
  for (const check of signedAppChecks(app, pins)) await command(check);
  if (!pins.signingCertSha1) {
    for (const [file, identifier] of SIGNED_COMPONENTS) {
      const identity = await command(["/usr/bin/codesign", "-d", "--verbose=4", join(app, file)]);
      if (!identity.split("\n").includes(`TeamIdentifier=${pins.appleTeamId}`) || !identity.split("\n").includes(`Identifier=${identifier}`) || !identity.includes("Authority=Developer ID Application:")) throw Error("Apple signing identity mismatch");
    }
  }
  const metadata = JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8")) as VerifiedDesktopApp;
  if (metadata.nativeTransportAbi !== 1) throw Error("Signed native transport ABI mismatch");
  const info = parsePlistDictionary(readFileSync(join(app, "Contents/Info.plist"), "utf8"));
  if (info.CFBundleIdentifier !== "dev.pacer.desktop" || info.CFBundleExecutable !== "pacer" || info.CFBundleVersion !== metadata.version || info.CFBundleShortVersionString !== metadata.version) throw Error("Signed app version mismatch");
  return { ...metadata, appTree: appTreeDigest(app) };
}
export async function verifyProductionArchive(bytes: Uint8Array, arch: DesktopArch, pins: SignerPins): Promise<VerifiedDesktopApp> {
  if (process.platform !== "darwin") throw Error("Signature verification requires macOS");
  return inspectDesktopArchive(bytes, app => verifyApp(app, arch, pins));
}
/**
 * Checks for the disk image file itself. Interim images are unsigned: the app inside
 * carries the pinned signatures. Developer ID images are signed, notarized and stapled.
 */
export function diskImageChecks(image: string, pins: SignerPins): string[][] {
  if (pins.signingCertSha1) return [];
  return [["/usr/bin/codesign", "--verify", "--strict", `-R=${signerRequirement(DISK_IMAGE_IDENTIFIER, pins)}`, image], ["/usr/bin/xcrun", "stapler", "validate", image], ["/usr/sbin/spctl", "--assess", "--type", "open", "--context", "context:primary-signature", image]];
}
/** The first-install disk image must hold an app identical to the update archive's. */
export async function verifyProductionDiskImage(bytes: Uint8Array, arch: DesktopArch, pins: SignerPins): Promise<VerifiedDesktopApp> {
  if (process.platform !== "darwin") throw Error("Signature verification requires macOS");
  return inspectDesktopDiskImage(bytes, async (app, image) => {
    for (const check of diskImageChecks(image, pins)) await command(check);
    return verifyApp(app, arch, pins);
  });
}
