import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { CoreError } from "../../core/errors";
import { desktopServiceLabel, parseDesktopServiceRegistration, parsePlistDictionary, servicePath } from "../../service";
import { DEFAULT_PORT } from "../../serve/constants";
import type { Ctx } from "../../types";
import { isVersion } from "../version";
import type { Installation } from "./types";

/** Stable identity fingerprint; callers must independently verify every input's provenance. */
export function installationFingerprint(identity: Omit<Installation, "id" | "version">, binary: string, registrationText: string): string {
  const {appPath,bundleId,ownerUid,arch,pacerHome,port,serviceLabel,ownership}=identity;
  return createHash("sha256").update(JSON.stringify({appPath,bundleId,ownerUid,arch,pacerHome,port,serviceLabel,ownership,binary,registrationText})).digest("hex");
}

export const BUNDLE_ID = "dev.pacer.desktop";
export const BUNDLE_RELEASE_PATH = "Contents/Resources/pacer-release.json";
export const BUNDLED_CLI_PATH = "Contents/Resources/pacer";
export const BUNDLED_CORE_PATH = "Contents/Resources/pacer-core";
export const BUNDLED_HELPER_PATH = "Contents/Resources/pacer-update-helper";
const bundleReleaseSchema = z.object({
  schema: z.literal(1), bundleId: z.literal(BUNDLE_ID), version: z.string().refine(isVersion),
  arch: z.enum(["aarch64", "x86_64"]),
  protocolMajors: z.array(z.number().int().positive()).min(1),
  admissionProtocol: z.literal(1), rollbackCompatible: z.literal(true), nativeTransportAbi: z.literal(1),
  cliLayout: z.literal("paired").optional(),
});
/** Packaging writes this before signing. Its declarations are trusted only after native signature verification. */
export type BundleRelease = z.infer<typeof bundleReleaseSchema>;
export function parseBundleRelease(value: unknown): BundleRelease {
  const result = bundleReleaseSchema.safeParse(value);
  if (!result.success) throw refusal("Unsupported desktop release metadata or admission protocol");
  return result.data;
}
function refusal(message: string): CoreError {
  return new CoreError("not_allowed", message,
    "Use a writable, user-owned desktop installation. Reconnect or explicitly adopt the intended service; older or coexisting CLIs require verified admission support before any update.");
}

/** Conservative refusal guard, not proof of a signed app. It also works without registration or install environment. */
export function isBundledExecutable(execPath: string): boolean {
  const bundled = (path: string) => /\.app\/Contents\/(?:Resources|MacOS)\/.+/i.test(path);
  if (bundled(resolve(execPath))) return true;
  try { return bundled(realpathSync(execPath)); } catch { return false; }
}

function owned(path: string, uid: number, kind: "file" | "directory", executable = false): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory()) || info.uid !== uid || (info.mode & 0o022)) {
    throw refusal("Desktop installation contains an unowned, writable-by-others, or redirected path");
  }
  if (executable) accessSync(path, constants.X_OK);
}
function bundleFile(app: string, relative: string, uid: number, executable = false): string {
  const path = join(app, relative);
  for (let parent = dirname(path); parent !== app; parent = dirname(parent)) owned(parent, uid, "directory");
  owned(path, uid, "file", executable);
  if (realpathSync(path) !== path) throw refusal("Desktop bundle payload was redirected");
  return path;
}

/**
 * Trusted native registration ONLY; never accept appPath from a public API request.
 * Native must first verify signing identity, architecture, bundled executable versions and
 * the authenticated running service (PID/birth identity, argv, UID, home, port, admission).
 * This static inspection neither proves that launchd loaded this file nor excludes older
 * coexisting CLI processes. The native adapter must establish that evidence before any mutation.
 * No registration means bootstrap is required; this function never installs or adopts.
 */
export async function inspectInstallation(ctx: Ctx, appPath: string): Promise<Installation> {
  try {
    if (!isAbsolute(appPath)) throw refusal("Desktop app path must be absolute");
    const app = realpathSync(appPath), uid = process.getuid?.();
    if (uid === undefined || !app.endsWith(".app") || app.split("/").includes("AppTranslocation")) throw refusal("Unsupported or translocated desktop installation");
    owned(app, uid, "directory");
    const parent = statSync(dirname(app));
    if (!(parent.mode & 0o222)) throw refusal("Desktop destination is read-only");
    accessSync(dirname(app), constants.W_OK | constants.X_OK);
    accessSync(app, constants.W_OK | constants.X_OK);
    const metadata = bundleFile(app, BUNDLE_RELEASE_PATH, uid);
    if (statSync(metadata).size > 64 * 1024) throw refusal("Desktop release metadata exceeds inspection limit");
    const release = parseBundleRelease(JSON.parse(readFileSync(metadata, "utf8")));
    const hostArch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
    if (release.arch !== hostArch) throw refusal("Desktop architecture does not match this process");
    const infoPath = bundleFile(app, "Contents/Info.plist", uid);
    const info = parsePlistDictionary(readFileSync(infoPath, "utf8"));
    if (info.CFBundleIdentifier !== release.bundleId || info.CFBundleShortVersionString !== release.version || info.CFBundleExecutable !== "pacer") {
      throw refusal("Desktop bundle identity or version does not match its release metadata");
    }
    bundleFile(app, "Contents/MacOS/pacer", uid, true);
    const cli = bundleFile(app, BUNDLED_CLI_PATH, uid, true);
    if (release.cliLayout === "paired") bundleFile(app, BUNDLED_CORE_PATH, uid, true);
    bundleFile(app, BUNDLED_HELPER_PATH, uid, true);
    const pacerHome = realpathSync(ctx.pacerHome), home = realpathSync(ctx.home);
    owned(pacerHome, uid, "directory");
    const portText = ctx.env.PACER_PORT ?? String(DEFAULT_PORT), port = Number(portText);
    if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw refusal("Invalid installation port");
    const registrationPath = servicePath(ctx, "darwin");
    owned(registrationPath, uid, "file");
    if (realpathSync(registrationPath) !== servicePath({ ...ctx, home }, "darwin")) throw refusal("Service registration path was redirected");
    const registrationText = readFileSync(registrationPath, "utf8");
    const registration = parseDesktopServiceRegistration(registrationText,desktopServiceLabel(ctx));
    if (!isAbsolute(registration.home) || !isAbsolute(registration.pacerHome) ||
        realpathSync(registration.home) !== home || realpathSync(registration.pacerHome) !== pacerHome || registration.port !== port) {
      throw refusal("Registered service belongs to a different home or port");
    }
    const executable = registration.argv[0]!;
    if (!isAbsolute(executable)) throw refusal("Service executable must be an absolute standalone path");
    const binary = realpathSync(executable);
    owned(binary, uid, "file", true);
    if (binary !== cli && isBundledExecutable(binary)) throw refusal("Service belongs to another desktop installation");
    const identity = { appPath: app, bundleId: release.bundleId, ownerUid: uid, arch: release.arch,
      pacerHome, port, serviceLabel: registration.label, ownership: binary === cli ? "managed" as const : "attached" as const };
    // Bind the static registration and resolved executable as well as the public identity.
    // This detects an attached executable alias being redirected without changing its plist.
    const id = installationFingerprint(identity, binary, registrationText);
    return { id, ...identity, version: release.version };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw refusal(`Cannot establish desktop installation ownership: ${(error as Error).message}`);
  }
}

/** Recheck every persisted field; this does not replace the native checks documented above. */
export async function verifyInstallation(ctx: Ctx, expected: Installation): Promise<void> {
  const actual = await inspectInstallation(ctx, expected.appPath);
  for (const key of Object.keys(actual) as (keyof Installation)[]) {
    if (actual[key] !== expected[key]) throw new CoreError("conflict", `Desktop installation ${key} changed`, "Reconnect the desktop and verify its service before retrying.");
  }
}
