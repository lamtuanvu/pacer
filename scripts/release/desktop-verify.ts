import { mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
    if (code) throw Error(`Desktop verification failed: ${argv[0]} ${argv[1]}`);
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
export async function verifyProductionArchive(bytes: Uint8Array, arch: DesktopArch, teamId: string): Promise<BundleMetadata> {
  if (process.platform !== "darwin") throw Error("Apple signature/notarization verification requires macOS");
  return inspectDesktopArchive(bytes, async app => {
    await command(["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
    for (const [file, identifier] of [["Contents/MacOS/pacer", "dev.pacer.desktop"], ["Contents/Resources/pacer", "dev.pacer.cli"], ["Contents/Resources/pacer-update-helper", "dev.pacer.desktop.update-helper"], ["Contents/Frameworks/libpacer-native.dylib", "dev.pacer.desktop.native-shim"]]) {
      const binary = join(app, file);
      (file.endsWith(".dylib") ? verifyNativeLibrary : verifyDesktopExecutable)(readFileSync(binary), arch);
      await command(["/usr/bin/codesign", "--verify", "--strict", binary]);
      const identity = await command(["/usr/bin/codesign", "-d", "--verbose=4", binary]);
      if (!identity.split("\n").includes(`TeamIdentifier=${teamId}`) || !identity.split("\n").includes(`Identifier=${identifier}`) || !identity.includes("Authority=Developer ID Application:")) throw Error("Apple signing identity mismatch");
    }
    await command(["/usr/bin/xcrun", "stapler", "validate", app]);
    await command(["/usr/sbin/spctl", "--assess", "--type", "execute", app]);
    const metadata = JSON.parse(readFileSync(join(app, "Contents/Resources/pacer-release.json"), "utf8")) as BundleMetadata;
    if (metadata.nativeTransportAbi !== 1) throw Error("Signed native transport ABI mismatch");
    const info = parsePlistDictionary(readFileSync(join(app, "Contents/Info.plist"), "utf8"));
    if (info.CFBundleIdentifier !== "dev.pacer.desktop" || info.CFBundleExecutable !== "pacer" || info.CFBundleVersion !== metadata.version || info.CFBundleShortVersionString !== metadata.version) throw Error("Signed app version mismatch");
    return metadata;
  });
}
