import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseManifest } from "./manifest";
import { PLUGIN_ID, type PluginManifest } from "./protocol";
import type { PublisherKey } from "./publishers";
import type { Ctx } from "../types";

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
const BLOCK = 512;
const MAX_TAR_BYTES = MAX_FILE_BYTES + MAX_ENTRIES * 2 * BLOCK + 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface InspectedArchive {
  readonly manifest: PluginManifest;
  readonly entries: readonly { readonly path: string; readonly size: number }[];
}
export interface VerifiedArchive extends InspectedArchive { readonly verified: true }
type FileEntry = { path: string; bytes: Buffer };
type PrivateArchive = { compressed: Buffer; files: FileEntry[] };
const inspectedArchives = new WeakMap<InspectedArchive, PrivateArchive>();
const verifiedArchives = new WeakMap<VerifiedArchive, PrivateArchive>();

function field(block: Buffer, start: number, width: number): string {
  const bytes = block.subarray(start, start + width);
  const nul = bytes.indexOf(0);
  const value = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) throw new Error("ambiguous tar header field");
  return decoder.decode(value);
}
function octal(block: Buffer, start: number, width: number): number {
  const value = field(block, start, width).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("invalid tar octal field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("tar number exceeds safe range");
  return number;
}
function validName(name: string, directory: boolean): string {
  if (!name || name.startsWith("/") || name.includes("\\") || !/^[A-Za-z0-9._/@+\-]+$/.test(name)) throw new Error("absolute or invalid archive path");
  if (directory && !name.endsWith("/")) throw new Error("directory must end in slash");
  if (!directory && name.endsWith("/")) throw new Error("regular file cannot end in slash");
  const canonical = directory ? name.slice(0, -1) : name;
  if (canonical.split("/").some(part => !part || part === "." || part === "..")) throw new Error("traversal or ambiguous archive path");
  return canonical;
}
function parseTar(tar: Buffer): { root: string; files: FileEntry[] } {
  const seen = new Set<string>(), kinds = new Map<string, "file" | "directory">(), descendants = new Map<string, number>(), files: FileEntry[] = [];
  let cursor = 0, count = 0, expanded = 0, root = "", ended = false;
  while (cursor + BLOCK <= tar.length) {
    const header = tar.subarray(cursor, cursor + BLOCK);
    if (header.every(byte => byte === 0)) {
      if (cursor + 2 * BLOCK > tar.length || !tar.subarray(cursor).every(byte => byte === 0)) throw new Error("trailing or truncated tar data");
      ended = true;
      break;
    }
    if (++count > MAX_ENTRIES) throw new Error("archive entry count exceeds 10000");
    const stored = octal(header, 148, 8);
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== stored) throw new Error("tar checksum mismatch");
    if (field(header, 257, 6) !== "ustar" || field(header, 263, 2) !== "00") throw new Error("unsupported tar header format");
    if (header.subarray(345, 512).some(byte => byte !== 0) || header.subarray(157, 257).some(byte => byte !== 0)) throw new Error("tar prefix, link target or extension unsupported");
    if (header.subarray(265, 345).some(byte => byte !== 0)) throw new Error("tar owner or device extension unsupported");
    if (octal(header, 108, 8) !== 0 || octal(header, 116, 8) !== 0 || octal(header, 136, 12) !== 0) throw new Error("tar owner or timestamp unsupported");
    const type = header[156];
    const rejected: Record<number, string> = { 49: "hardlink", 50: "link", 51: "device", 52: "device", 54: "device", 76: "gnu long name", 75: "gnu long link", 83: "sparse", 120: "pax", 103: "pax" };
    if (type !== 0 && type !== 48 && type !== 53) throw new Error(`unsupported ${rejected[type] ?? "extension"} archive entry`);
    const directory = type === 53;
    const mode = octal(header, 100, 8);
    if (directory ? mode !== 0o700 : mode !== 0o600 && mode !== 0o700) throw new Error("unsafe tar mode");
    const name = validName(field(header, 0, 100), directory);
    if (seen.has(name)) throw new Error(name.endsWith("/pacer-plugin.json") ? "duplicate manifest" : "duplicate archive path");
    seen.add(name);
    const alias = name.toLowerCase();
    if (kinds.has(alias)) throw new Error("case-colliding archive path");
    const ancestors = alias.split("/").slice(0, -1);
    for (let i = 1; i <= ancestors.length; i++) {
      const parent = ancestors.slice(0, i).join("/");
      if (kinds.get(parent) === "file") throw new Error("file/descendant archive path collision");
    }
    if (!directory && descendants.has(alias)) throw new Error("file/descendant archive path collision");
    kinds.set(alias, directory ? "directory" : "file");
    for (let i = 1; i <= ancestors.length; i++) {
      const parent = ancestors.slice(0, i).join("/");
      descendants.set(parent, (descendants.get(parent) ?? 0) + 1);
    }
    if (!root) {
      if (!directory || !PLUGIN_ID.test(name)) throw new Error("archive must begin with one id root directory");
      root = name;
    } else if (!name.startsWith(`${root}/`)) throw new Error("second root or root shadowing refused");
    const size = octal(header, 124, 12);
    if (directory && size !== 0) throw new Error("directory has data");
    if (size > MAX_FILE_BYTES || expanded + size > MAX_FILE_BYTES) throw new Error("oversized file or expanded bytes exceed 200 MB");
    const dataStart = cursor + BLOCK, padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > tar.length) throw new Error("truncated tar entry");
    if (tar.subarray(dataStart + size, dataStart + padded).some(byte => byte !== 0)) throw new Error("nonzero tar padding");
    if (!directory) { files.push({ path: name, bytes: tar.subarray(dataStart, dataStart + size) }); expanded += size; }
    cursor = dataStart + padded;
  }
  if (!ended) throw new Error("truncated tar trailer");
  return { root, files };
}
export function inspectArchive(input: Uint8Array): InspectedArchive {
  if (!input.length || input.length > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 50 MB compressed limit");
  const compressed = Buffer.from(input);
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES }); }
  catch { throw new Error("invalid or oversized gzip archive"); }
  const { root, files } = parseTar(tar);
  const manifestFiles = files.filter(file => file.path === `${root}/pacer-plugin.json`);
  if (manifestFiles.length !== 1 || manifestFiles[0]!.bytes.length > 1024 * 1024) throw new Error("missing manifest or oversized manifest");
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(manifestFiles[0]!.bytes)); }
  catch { throw new Error("invalid manifest JSON"); }
  const parsed = parseManifest(raw);
  if (!parsed.ok || parsed.manifest.id !== root) throw new Error("manifest identity invalid");
  if (parsed.manifest.entry) {
    validName(parsed.manifest.entry, false);
    if (!files.some(file => file.path === `${root}/${parsed.manifest.entry}`)) throw new Error("manifest entry missing from archive");
  }
  const entries = Object.freeze(files.map(file => Object.freeze({ path: file.path, size: file.bytes.length })));
  const inspection = Object.freeze({ manifest: Object.freeze(parsed.manifest), entries });
  inspectedArchives.set(inspection, { compressed, files });
  return inspection;
}
function strictBase64(value: string, length: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalid signature or key encoding");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== length || bytes.toString("base64") !== value) throw new Error("invalid signature or key length");
  return bytes;
}
export async function verifyArchive(inspection: InspectedArchive, signature: string, publicKey: string): Promise<VerifiedArchive> {
  const privateData = inspectedArchives.get(inspection);
  if (!privateData) throw new Error("archive inspection provenance missing");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(strictBase64(publicKey, 32)), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, Uint8Array.from(strictBase64(signature, 64)), Uint8Array.from(privateData.compressed))) throw new Error("archive signature invalid");
  const verified = Object.freeze({ manifest: inspection.manifest, entries: inspection.entries, verified: true as const });
  verifiedArchives.set(verified, privateData);
  return verified;
}
/** Verify against the trusted key of the manifest's publisher; an unknown publisher fails closed. */
export async function verifyPublishedArchive(ctx: Ctx, inspection: InspectedArchive, signature: string,
  trust: { lookup(ctx: Ctx, publisher: string): PublisherKey | null }): Promise<VerifiedArchive> {
  const publisher = trust.lookup(ctx, inspection.manifest.publisher);
  if (!publisher) throw new Error("unknown publisher; no trusted key");
  return verifyArchive(inspection, signature, publisher.key);
}
export function extractArchive(archive: VerifiedArchive, destination: string): void {
  const privateData = verifiedArchives.get(archive);
  if (!privateData) throw new Error("verified archive provenance missing");
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || readdirSync(destination).length) throw new Error("destination must be an empty private owned directory");
  const root = archive.manifest.id;
  for (const file of privateData.files) {
    const path = join(destination, file.path.slice(root.length + 1));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const mode = file.path === `${root}/${archive.manifest.entry}` ? 0o700 : 0o600;
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      let written = 0;
      while (written < file.bytes.length) written += writeSync(fd, file.bytes, written);
      if (fstatSync(fd).size !== file.bytes.length) throw new Error("short archive write");
    }
    finally { closeSync(fd); }
  }
}
