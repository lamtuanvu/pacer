import { mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { signerRequirement, type SignerPins } from "../../src/update/desktop/signer-requirement";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parsePlistDictionary } from "../../src/service";
import { verifyDesktopExecutable, verifyNativeLibrary } from "./desktop";
import { validateDesktopTar } from "./desktop-tar";
import type { BundleMetadata, DesktopArch } from "./desktop-feed";

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
export async function verifyProductionArchive(bytes: Uint8Array, arch: DesktopArch, pins: SignerPins): Promise<BundleMetadata> {
  if (process.platform !== "darwin") throw Error("Signature verification requires macOS");
  return inspectDesktopArchive(bytes, async app => {
    for (const [file] of SIGNED_COMPONENTS) (file.endsWith(".dylib") ? verifyNativeLibrary : verifyDesktopExecutable)(readFileSync(join(app, file)), arch);
    for (const check of signedAppChecks(app, pins)) await command(check);
    if (!pins.signingCertSha1) {
      for (const [file, identifier] of SIGNED_COMPONENTS) {
        const identity = await command(["/usr/bin/codesign", "-d", "--verbose=4", join(app, file)]);
        if (!identity.split("\n").includes(`TeamIdentifier=${pins.appleTeamId}`) || !identity.split("\n").includes(`Identifier=${identifier}`) || !identity.includes("Authority=Developer ID Application:")) throw Error("Apple signing identity mismatch");
      }
    }
    const metadata = JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8")) as BundleMetadata;
    if (metadata.nativeTransportAbi !== 1) throw Error("Signed native transport ABI mismatch");
    const info = parsePlistDictionary(readFileSync(join(app, "Contents/Info.plist"), "utf8"));
    if (info.CFBundleIdentifier !== "dev.pacer.desktop" || info.CFBundleExecutable !== "pacer" || info.CFBundleVersion !== metadata.version || info.CFBundleShortVersionString !== metadata.version) throw Error("Signed app version mismatch");
    return metadata;
  });
}
