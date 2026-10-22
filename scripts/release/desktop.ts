#!/usr/bin/env bun
import { chmodSync, existsSync, copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parsePlistDictionary } from "../../src/service";
import { assetFile, parseManifest, parseSha256Sums, sha256Hex } from "../../src/update/manifest";
import { isVersion } from "../../src/update/version";

type Arch = "aarch64" | "x86_64";
type Run = (argv: string[]) => Promise<string>;

/** Require thin, native Mach-O executables. Universal packages have a separate release contract. */
export function verifyDesktopExecutable(bytes: Buffer, arch: Arch): void {
  verifyMachO(bytes, arch, 2);
}
export function verifyNativeLibrary(bytes: Buffer, arch: Arch): void {
  verifyMachO(bytes, arch, 6);
}
function verifyMachO(bytes: Buffer, arch: Arch, kind: number): void {
  const cpu = arch === "aarch64" ? 0x0100000c : 0x01000007;
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu || bytes.readUInt32LE(12) !== kind) {
    throw new Error("Desktop executable architecture/type does not match the release");
  }
}

function regular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw new Error("Desktop payload must be a regular executable, not a symlink");
  return readFileSync(path);
}

function safeTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("Desktop staging refuses symlink payloads");
  if (stat.isDirectory()) for (const name of readdirSync(path)) safeTree(join(path, name));
  else if (!stat.isFile()) throw new Error("Desktop staging refuses special files");
}

const runBinary: Run = async argv => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, PACER_BIN: undefined } });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Desktop version smoke test failed (${code}): ${stderr.slice(0, 1000)}`);
    return stdout;
  } finally { clearTimeout(timer); }
};

/** Build only the repository's fixed transport shim, never code supplied by a release feed. */
export async function buildNativeShim(root: string, output: string, arch: Arch, run: Run = runBinary): Promise<void> {
  if (arch !== "aarch64" && arch !== "x86_64") throw new Error("Unsupported desktop architecture");
  const source = join(root, "src/update/desktop/native-socket.c"), stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || existsSync(output)) throw new Error("Invalid native shim build input/output");
  await run(["/usr/bin/xcrun", "clang", "-target", `${arch === "aarch64" ? "arm64" : "x86_64"}-apple-macos11`,
    "-dynamiclib", "-O2", "-Wall", "-Wextra", "-Werror", "-Wl,-install_name,@rpath/libpacer-native.dylib", source, "-o", output]);
  verifyNativeLibrary(regular(output), arch);
}

/**
 * Inputs: verified CLI release directory plus unsigned pacer.app and pacer-update-helper.
 * Output: a fresh private directory containing the complete unsigned pacer.app.
 * Every input is checked before any executable runs. Sign only the returned app.
 */
export async function stageDesktopPackage(root: string, releaseDir: string, arch: Arch, options: { run?: Run } = {}): Promise<string> {
  if (arch !== "aarch64" && arch !== "x86_64") throw new Error("Unsupported desktop architecture");
  const dir = realpathSync(releaseDir);
  const version: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !isVersion(version)) throw new Error("Invalid package version");
  const manifest = parseManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  if (manifest.version !== version) throw new Error("Desktop release version differs from package version");
  const platform = { os: "darwin" as const, arch: arch === "aarch64" ? "arm64" as const : "x64" as const };
  const file = assetFile(platform), cli = join(dir, file), helper = join(dir, "pacer-update-helper"), app = join(dir, "pacer.app");
  safeTree(app);
  const cliBytes = regular(cli), asset = manifest.assets.find(a => a.file === file);
  const digest = sha256Hex(cliBytes);
  if (!asset || asset.size !== cliBytes.length || asset.sha256 !== digest || parseSha256Sums(readFileSync(join(dir, "SHA256SUMS"), "utf8")).get(file) !== digest) {
    throw new Error("Desktop CLI checksum/size mismatch");
  }
  const shell = join(app, "Contents/MacOS/pacer");
  for (const binary of [cli, helper, shell]) verifyDesktopExecutable(regular(binary), arch);
  const permissionHelper = join(app, "Contents/MacOS/pacer-permission-setup");
  if (existsSync(permissionHelper)) verifyDesktopExecutable(regular(permissionHelper), arch);
  const info = parsePlistDictionary(readFileSync(join(app, "Contents/Info.plist"), "utf8"));
  if (info.CFBundleIdentifier !== "dev.pacer.desktop" || info.CFBundleExecutable !== "pacer" || info.CFBundleVersion !== version || info.CFBundleShortVersionString !== version) {
    throw new Error("Desktop bundle identity/version mismatch");
  }
  const run = options.run ?? runBinary;
  for (const binary of [cli, helper, shell]) {
    const expected = binary === cli ? `pacer ${version}` : version;
    if ((await run([binary, "--version"])).trim() !== expected) throw new Error("Desktop component version mismatch");
  }
  const stage = mkdtempSync(join(dir, ".desktop-stage-"));
  chmodSync(stage, 0o700);
  try {
    const target = join(stage, "pacer.app");
    cpSync(app, target, { recursive: true, dereference: false });
    // Tauri also copies Cargo's helper binary here. Only the independently
    // validated Resources helper belongs in the release signing layout.
    const macos = join(target, "Contents/MacOS");
    rmSync(join(macos, "pacer-update-helper"), { force: true });
    const executables = readdirSync(macos);
    const allowed = ["pacer", ...(existsSync(permissionHelper) ? ["pacer-permission-setup"] : [])];
    if (executables.length !== allowed.length || executables.some(name => !allowed.includes(name))) throw new Error("Unsupported MacOS signing payload");
    // Existing signatures describe the incomplete input. The returned tree must be signed anew.
    rmSync(join(target, "Contents/_CodeSignature"), { recursive: true, force: true });
    const resources = join(target, "Contents/Resources");
    mkdirSync(resources, { recursive: true });
    copyFileSync(cli, join(resources, "pacer"));
    copyFileSync(helper, join(resources, "pacer-update-helper"));
    chmodSync(join(resources, "pacer"), 0o755);
    chmodSync(join(resources, "pacer-update-helper"), 0o755);
    const frameworks = join(target, "Contents/Frameworks");
    mkdirSync(frameworks, { recursive: true });
    if (readdirSync(frameworks).length) throw new Error("Unsupported nested signing payload");
    await buildNativeShim(root, join(frameworks, "libpacer-native.dylib"), arch, run);
    writeFileSync(join(resources, "pacer-release.json"), JSON.stringify({ schema: 1, bundleId: "dev.pacer.desktop", version, arch, protocolMajors: [3], admissionProtocol: 1, nativeTransportAbi: 1, rollbackCompatible: true }, null, 2) + "\n");
    return stage;
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}

if (import.meta.main) {
  const [releaseDir, arch] = process.argv.slice(2);
  if (!releaseDir || (arch !== "aarch64" && arch !== "x86_64") || process.argv.length !== 4) {
    console.error("usage: bun scripts/release/desktop.ts <release-directory> <aarch64|x86_64>");
    process.exit(2);
  }
  try { console.log(await stageDesktopPackage(resolve(import.meta.dir, "../.."), releaseDir, arch)); }
  catch (error) { console.error((error as Error).message); process.exit(1); }
}
