import { closeSync, constants, existsSync, fstatSync, lstatSync, linkSync, openSync, readdirSync, readSync, unlinkSync, writeSync, fsyncSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { inspectArchive, MAX_ARCHIVE_BYTES, MAX_ENTRIES, MAX_FILE_BYTES } from "../src/plugins/archive";

const BLOCK = 512;
type Input = { path: string; directory: boolean; bytes: Buffer };

function octal(header: Buffer, offset: number, width: number, value: number): void {
  const text = value.toString(8);
  if (text.length >= width) throw new Error("tar header number too large");
  header.write(text.padStart(width - 1, "0") + "\0", offset, width, "ascii");
}
function header(entry: Input, entryPoint: string): Buffer {
  const block = Buffer.alloc(BLOCK);
  const name = entry.path + (entry.directory ? "/" : "");
  if (Buffer.byteLength(name) > 100) throw new Error("plugin archive path exceeds ustar name limit");
  block.write(name, 0, 100, "utf8");
  octal(block, 100, 8, entry.directory || entry.path === entryPoint ? 0o700 : 0o600);
  octal(block, 108, 8, 0); octal(block, 116, 8, 0);
  octal(block, 124, 12, entry.bytes.length); octal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block.write(entry.directory ? "5" : "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii"); block.write("00", 263, 2, "ascii");
  octal(block, 148, 8, block.reduce((sum, byte) => sum + byte, 0));
  return block;
}
function inventory(folder: string): Input[] {
  const root = basename(folder);
  if (!/^[a-z0-9-]{2,64}$/.test(root) || !lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw new Error("invalid plugin folder");
  const entries: Input[] = [{ path: root, directory: true, bytes: Buffer.alloc(0) }];
  let expanded = 0;
  function walk(directory: string, relative: string): void {
    for (const name of readdirSync(directory).sort()) {
      if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("invalid plugin path");
      const path = join(directory, name), stat = lstatSync(path), archivePath = `${root}/${relative ? relative + "/" : ""}${name}`;
      if (stat.isSymbolicLink()) throw new Error("plugin input symlink refused");
      if (stat.isDirectory()) {
        entries.push({ path: archivePath, directory: true, bytes: Buffer.alloc(0) });
        walk(path, relative ? `${relative}/${name}` : name);
      } else if (stat.isFile() && stat.nlink === 1) {
        const bytes = readPluginInput(path, stat, MAX_FILE_BYTES - expanded);
        expanded += bytes.length;
        if (expanded > MAX_FILE_BYTES) throw new Error("plugin expanded bytes exceed 200 MB");
        entries.push({ path: archivePath, directory: false, bytes });
      } else throw new Error("unsupported plugin input type or hardlink");
      if (entries.length > MAX_ENTRIES) throw new Error("plugin archive entry count exceeds 10000");
    }
  }
  walk(folder, "");
  return entries;
}
/** Bind the opened regular file to the exact pathname identity observed by inventory. */
export function readPluginInput(path: string, inspected: Stats, remaining: number, afterLstat?: () => void): Buffer {
  afterLstat?.();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== inspected.dev || opened.ino !== inspected.ino || opened.nlink !== 1) {
      throw new Error("plugin input identity changed");
    }
    return readBoundedPluginFile(fd, remaining);
  } finally { closeSync(fd); }
}
/** Read only the checked size; the optional hook makes the growth race deterministic in tests. */
export function readBoundedPluginFile(fd: number, remaining: number, afterSizeChecked?: () => void): Buffer {
  const before = fstatSync(fd);
  if (!before.isFile() || before.nlink !== 1 || before.size > remaining) throw new Error("plugin input changed or exceeds 200 MB");
  afterSizeChecked?.();
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, null);
    if (count === 0) throw new Error("plugin input changed during bounded read");
    offset += count;
  }
  const extra = Buffer.alloc(1);
  const grew = readSync(fd, extra, 0, 1, null) !== 0;
  const after = fstatSync(fd);
  if (grew || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.nlink !== 1 ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
    throw new Error("plugin input changed during bounded read");
  }
  return bytes;
}
function privateKeyBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error("private key must be an owned 0600 regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 || (current.mode & 0o777) !== 0o600) throw new Error("private key identity changed");
    if (current.size > 16 * 1024) throw new Error("private key file too large");
    const pem = readBoundedPluginFile(fd, 16 * 1024).toString("utf8");
    const after = fstatSync(fd);
    if ((after.mode & 0o777) !== 0o600 || (process.getuid && after.uid !== process.getuid())) throw new Error("private key identity changed");
    const match = /^-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----\r?\n?$/.exec(pem);
    if (!match) throw new Error("private key PEM invalid");
    return Buffer.from(match[1]!.replace(/\s/g, ""), "base64");
  } finally { closeSync(fd); }
}
export function publishAbsent(path: string, bytes: Buffer, beforeLink?: () => void): { dev: number; ino: number } {
  const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let fd: number | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let linked = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
    const stat = fstatSync(fd);
    identity = { dev: stat.dev, ino: stat.ino };
    closeSync(fd);
    fd = undefined;
    beforeLink?.();
    linkSync(temp, path);
    linked = true;
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); }
    finally { closeSync(directory); }
    return identity;
  } catch (error) {
    if (linked && identity) {
      const current = lstatSync(path);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export async function packPlugin(folder: string, privateKeyFile: string, archiveFile: string): Promise<void> {
  if (existsSync(archiveFile) || existsSync(`${archiveFile}.sig`)) throw new Error("archive output already exists");
  const entries = inventory(folder);
  const manifestInput = entries.find(entry => entry.path === `${basename(folder)}/pacer-plugin.json` && !entry.directory);
  if (!manifestInput) throw new Error("missing plugin manifest");
  let manifest: { entry?: string };
  try { manifest = JSON.parse(manifestInput.bytes.toString("utf8")); }
  catch { throw new Error("invalid plugin manifest"); }
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(header(entry, `${basename(folder)}/${manifest.entry ?? ""}`));
    if (!entry.directory) blocks.push(entry.bytes, Buffer.alloc((BLOCK - entry.bytes.length % BLOCK) % BLOCK));
  }
  blocks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(blocks));
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds 50 MB compressed limit");
  inspectArchive(archive); // The packer must emit only the verifier's grammar.
  const keyBytes = privateKeyBytes(privateKeyFile);
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(keyBytes), "Ed25519", false, ["sign"]); }
  finally { keyBytes.fill(0); }
  const signature = Buffer.from(await crypto.subtle.sign("Ed25519", key, Uint8Array.from(archive))).toString("base64");
  const published = publishAbsent(archiveFile, archive);
  try { publishAbsent(`${archiveFile}.sig`, Buffer.from(signature + "\n")); }
  catch (error) {
    const current = lstatSync(archiveFile);
    if (current.dev === published.dev && current.ino === published.ino) unlinkSync(archiveFile);
    throw error;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--plugin-dir", "--key", "--out"].includes(args[i] ?? "") || !args[i + 1] || values.has(args[i]!)) {
      throw new Error("usage: bun scripts/plugin-pack.ts --plugin-dir DIR --key PRIVATE_KEY_FILE --out ARCHIVE.tgz");
    }
    values.set(args[i]!, args[i + 1]!);
  }
  if (values.size !== 3) throw new Error("usage: bun scripts/plugin-pack.ts --plugin-dir DIR --key PRIVATE_KEY_FILE --out ARCHIVE.tgz");
  await packPlugin(values.get("--plugin-dir")!, values.get("--key")!, values.get("--out")!);
}
