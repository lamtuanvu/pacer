import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compareVersions } from "../../src/update/version";
import { verifyProductionArchive } from "./desktop-verify";

export const DESKTOP_FEED_URL = "https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/stable.json";
export const DESKTOP_ARCHES = ["aarch64", "x86_64"] as const;
export type DesktopArch = typeof DESKTOP_ARCHES[number];
export type BundleMetadata = { schema: number; version: string; arch: string; bundleId: string; protocolMajors: number[]; admissionProtocol: number; nativeTransportAbi: number; rollbackCompatible: boolean; fixture: boolean };
export interface DesktopReleaseOptions {
  mode: "production" | "fixture";
  publicKey: string;
  teamId: string;
  /** Only explicit fixture mode may replace macOS validation. Production always uses the actual OS verifier. */
  verifyArchive?: (bytes: Uint8Array, arch: DesktopArch) => Promise<BundleMetadata>;
}
export interface DesktopPublisher {
  readonly mode: "production" | "fixture";
  readAsset(name: string): Promise<Uint8Array | null>;
  createAsset(name: string, bytes: Uint8Array): Promise<void>;
  readFeed(): Promise<{ head: string | null; feed: string | null }>;
  compareAndSwap(expected: string | null, feed: string): Promise<void>;
}
export function desktopAssetName(version: string, arch: DesktopArch): string { stableVersion(version); return `desktop-pacer-${version}-darwin-${arch}.app.tar.gz`; }
export function stableVersion(version: string): void {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw Error("Desktop stable releases require a stable semantic version");
}
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function base64(text: string): Buffer {
  if (!text || text.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw Error("Invalid updater signature encoding");
  return Buffer.from(text, "base64");
}
/** Minisign ED prehash + global trusted-comment signature, matching minisign-verify0.3.0. */
export function verifyUpdateSignature(bytes: Uint8Array, signature: string, publicKey: string, version: string): void {
  stableVersion(version);
  const publicLines = base64(publicKey.trim()).toString("utf8").trimEnd().split("\n");
  const lines = base64(signature.trim()).toString("utf8").trimEnd().split("\n");
  if (publicLines.length !== 2 || lines.length !== 4 || !publicLines[0].startsWith("untrusted comment: ") || !lines[0].startsWith("untrusted comment: ") || !lines[2].startsWith("trusted comment: ")) throw Error("Invalid updater signature envelope");
  const key = base64(publicLines[1]), packet = base64(lines[1]), global = base64(lines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed" || packet.length !== 74 || packet.subarray(0, 2).toString() !== "ED" || global.length !== 64 || !key.subarray(2, 10).equals(packet.subarray(2, 10))) throw Error("Invalid updater key/signature identity");
  const trusted = lines[2].slice(17), versions = trusted.split("\t").filter(field => field.startsWith("version:"));
  if (versions.length !== 1 || versions[0] !== `version:${version}` || /[\r\n]/.test(trusted)) throw Error("Updater signature does not bind the intended version");
  const publicObject = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]), format: "der", type: "spki" });
  const sig = packet.subarray(10);
  if (!verify(null, createHash("blake2b512").update(bytes).digest(), publicObject, sig) ||
      !verify(null, Buffer.concat([sig, Buffer.from(trusted)]), publicObject, global)) throw Error("Invalid updater artifact signature");
}
function input(path: string, max = 512 * 1024 * 1024): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > max) throw Error("Invalid desktop release input");
  return readFileSync(path);
}
const releaseSchema = z.object({ schema: z.literal(1), version: z.string(), notes: z.string().refine(text => Buffer.byteLength(text, "utf8") <= 32768, "Desktop notes exceed native wire limit"), pub_date: z.iso.datetime() }).strict();
function productionOptions(): DesktopReleaseOptions {
  const publicKey = process.env.PACER_OTA_PUBLIC_KEY, teamId = process.env.PACER_APPLE_TEAM_ID;
  if (!publicKey || !teamId || !/^[A-Z0-9]{10}$/.test(teamId)) throw Error("Production desktop trust inputs are not configured");
  return { mode: "production", publicKey, teamId };
}
async function validate(releaseDir: string, version: string, options: DesktopReleaseOptions) {
  stableVersion(version);
  if (!options.publicKey || !/^[A-Z0-9]{10}$/.test(options.teamId)) throw Error("Invalid desktop trust inputs");
  if (options.mode === "production" && options.verifyArchive) throw Error("Production desktop validation cannot use a fixture verifier");
  const manifestName = `desktop-release-${version}.json`, manifestBytes = input(join(releaseDir, manifestName), 128 * 1024);
  const manifest = releaseSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.version !== version) throw Error("Desktop release manifest version mismatch");
  const assets = new Map<string, Uint8Array>([[manifestName, manifestBytes]]);
  const platforms: Record<string, unknown> = {};
  for (const arch of DESKTOP_ARCHES) {
    const name = desktopAssetName(version, arch), bytes = input(join(releaseDir, name)), signatureBytes = input(join(releaseDir, name + ".sig"), 8193), signature = signatureBytes.toString("utf8").trim();
    if (signature.length > 8192) throw Error("Desktop signature exceeds native wire limit");
    verifyUpdateSignature(bytes, signature, options.publicKey, version);
    const metadata = options.mode === "fixture" ? await options.verifyArchive?.(bytes, arch) : await verifyProductionArchive(bytes, arch, options.teamId);
    if (!metadata || metadata.schema !== 1 || metadata.version !== version || metadata.arch !== arch || metadata.bundleId !== "dev.pacer.desktop" ||
        metadata.protocolMajors.length !== 1 || metadata.protocolMajors[0] !== 3 || metadata.admissionProtocol !== 1 || metadata.nativeTransportAbi !== 1 || !metadata.rollbackCompatible || metadata.fixture !== (options.mode === "fixture")) throw Error("Signed desktop metadata/identity mismatch");
    platforms[`darwin-${arch}`] = { url: `https://github.com/lamtuanvu/pacer/releases/download/v${version}/${name}`, signature, sha256: digest(bytes), bundleId: metadata.bundleId, protocolMajors: metadata.protocolMajors, admissionProtocol: 1, rollbackCompatible: true };
    assets.set(name, bytes); assets.set(name + ".sig", signatureBytes);
  }
  return { feed: JSON.stringify({ ...manifest, platforms }, null, 2) + "\n", assets };
}
export async function validateDesktopRelease(releaseDir: string, version: string, options = productionOptions()): Promise<void> { await validate(releaseDir, version, options); }
export async function buildDesktopFeed(releaseDir: string, version: string, options = productionOptions()): Promise<string> { return (await validate(releaseDir, version, options)).feed; }
export async function publishDesktopRelease(releaseDir: string, version: string, publisher: DesktopPublisher, options = productionOptions()): Promise<void> {
  if (publisher.mode !== options.mode) throw Error("A fixture cannot authorize production publication");
  const validated = await validate(releaseDir, version, options);
  const previous = await publisher.readFeed();
  if (previous.feed) {
    const old = JSON.parse(previous.feed); stableVersion(old.version);
    if (compareVersions(old.version, version) > 0) throw Error("Desktop promotion cannot downgrade the stable feed");
  }
  for (const [name, bytes] of validated.assets) {
    let existing = await publisher.readAsset(name);
    if (!existing) {
      try { await publisher.createAsset(name, bytes); }
      catch (error) { if (!await publisher.readAsset(name)) throw error; }
      existing = await publisher.readAsset(name);
    }
    if (!existing || existing.byteLength !== bytes.byteLength || digest(existing) !== digest(bytes)) throw Error(`Desktop immutable asset conflict: ${name}`);
  }
  if (previous.feed === validated.feed) return;
  if (previous.feed && JSON.parse(previous.feed).version === version) throw Error("Desktop immutable version conflict");
  try { await publisher.compareAndSwap(previous.head, validated.feed); }
  catch (error) { if ((await publisher.readFeed()).feed !== validated.feed) throw error; }
}
