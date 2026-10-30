import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { withLock } from "../core/lock";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import shippedPublishers from "../../plugins/publishers.json";

export interface PublisherKey { key: string; fingerprint: string; source: "shipped" | "user" }
interface Store { version: 1; publishers: Record<string, string> }
const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;
const STORE_MAX_BYTES = 64 * 1024;
const ED25519_P = (1n << 255n) - 19n;
/** The eight canonical encodings of the small-order Ed25519 points (plus two sign-bit aliases); the identity key would verify every message. */
const SMALL_ORDER_KEYS = new Set([
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  // x = 0 with the sign bit set: non-canonical aliases of the identity and the order-2 point.
  "0100000000000000000000000000000000000000000000000000000000000080",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
]);
/** Refuse small-order points and non-canonical encodings (y >= p), which could alias a small-order point. */
export function assertStrongPublisherKey(bytes: Uint8Array): void {
  const hex = Buffer.from(bytes).toString("hex");
  const y = BigInt(`0x${Buffer.from(bytes).reverse().toString("hex")}`) & ((1n << 255n) - 1n);
  if (bytes.length !== 32 || SMALL_ORDER_KEYS.has(hex) || y >= ED25519_P) throw new CoreError("invalid_input", "publisher key is a weak or non-canonical Ed25519 point");
}
function keyBytes(key: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(key)) throw new CoreError("invalid_input", "publisher key must be canonical base64");
  const bytes = Buffer.from(key, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== key) throw new CoreError("invalid_input", "publisher key must encode 32 bytes");
  assertStrongPublisherKey(bytes);
  return bytes;
}
export function publisherFingerprint(key: string): string {
  return createHash("sha256").update(keyBytes(key)).digest("hex");
}
function publisherName(name: string): void {
  if (!NAME.test(name) || name.trim() !== name) throw new CoreError("invalid_input", "invalid publisher name");
}
function storeRoot(ctx: Ctx): string { return join(ctx.pacerHome, "plugins"); }
function storePath(ctx: Ctx): string { return join(storeRoot(ctx), "publishers.json"); }
function assertNoRedirectedParent(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new CoreError("plugin_refused", "redirected publisher parent path");
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, component);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoreError("plugin_refused", "redirected publisher parent path");
  }
}
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function privateRoot(ctx: Ctx, create: boolean): boolean {
  const root = storeRoot(ctx);
  assertNoRedirectedParent(root);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoRedirectedParent(root);
  if (!pathExists(root)) return false;
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) ||
      (process.getuid && stat.uid !== process.getuid())) throw new CoreError("plugin_refused", "publisher directory must be owned and not writable by others");
  if (create && (stat.mode & 0o777) !== 0o700) {
    const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== stat.uid) {
        throw new CoreError("plugin_refused", "publisher directory changed before mode migration");
      }
      fchmodSync(fd, 0o700);
      const migrated = fstatSync(fd);
      if (migrated.dev !== stat.dev || migrated.ino !== stat.ino || (migrated.mode & 0o777) !== 0o700) {
        throw new CoreError("plugin_refused", "publisher directory mode migration failed");
      }
    } finally { closeSync(fd); }
    const current = lstatSync(root);
    if (current.dev !== stat.dev || current.ino !== stat.ino || (current.mode & 0o777) !== 0o700) {
      throw new CoreError("plugin_refused", "publisher directory changed after mode migration");
    }
  }
  return true;
}
function readPrivateFile(path: string): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 ||
      (process.getuid && before.uid !== process.getuid())) throw new CoreError("plugin_refused", "publisher store must be private and owned");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > STORE_MAX_BYTES) throw new CoreError("plugin_refused", "invalid publisher store identity or size");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) throw new CoreError("plugin_refused", "publisher store changed during read");
      offset += count;
    }
    const extra = Buffer.alloc(1);
    const grew = readSync(fd, extra, 0, 1, null) !== 0;
    const after = fstatSync(fd);
    if (grew || after.dev !== before.dev || after.ino !== before.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || (after.mode & 0o777) !== 0o600) {
      throw new CoreError("plugin_refused", "publisher store changed during read");
    }
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}
function load(ctx: Ctx): Store {
  if (!privateRoot(ctx, false) || !pathExists(storePath(ctx))) return { version: 1, publishers: {} };
  const raw = readPrivateFile(storePath(ctx));
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new CoreError("plugin_refused", "invalid publisher store JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["publishers", "version"]) ||
      (parsed as Store).version !== 1 || !(parsed as Store).publishers ||
      typeof (parsed as Store).publishers !== "object" || Array.isArray((parsed as Store).publishers)) {
    throw new CoreError("plugin_refused", "invalid publisher store shape");
  }
  const publishers = (parsed as Store).publishers;
  for (const [name, key] of Object.entries(publishers)) {
    publisherName(name);
    if (typeof key !== "string") throw new CoreError("plugin_refused", "invalid publisher key");
    keyBytes(key);
  }
  if (raw !== JSON.stringify(parsed, null, 2) + "\n") throw new CoreError("plugin_refused", "invalid publisher store encoding");
  return parsed as Store;
}
function writeStore(ctx: Ctx, store: Store): void {
  privateRoot(ctx, true);
  const path = storePath(ctx), temp = join(dirname(path), `.${crypto.randomUUID()}.publishers.tmp`);
  const parent = lstatSync(dirname(path));
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.from(JSON.stringify(store, null, 2) + "\n");
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertNoRedirectedParent(dirname(path));
    const current = lstatSync(dirname(path));
    if (current.dev !== parent.dev || current.ino !== parent.ino || (current.mode & 0o022)) {
      throw new CoreError("plugin_refused", "publisher directory changed before publication");
    }
    renameSync(temp, path);
    assertNoRedirectedParent(dirname(path));
    const publishedParent = lstatSync(dirname(path));
    if (publishedParent.dev !== parent.dev || publishedParent.ino !== parent.ino) {
      throw new CoreError("plugin_refused", "publisher directory changed during publication");
    }
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); }
    finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
/** Publisher names are compared case-insensitively for collisions so `acme` cannot pose as `Acme`. */
function foldedName(name: string): string { return name.toLowerCase(); }
export function createPublisherTrust(shipped: Readonly<Record<string, string>>) {
  for (const [name, key] of Object.entries(shipped)) { publisherName(name); keyBytes(key); }
  const shippedCopy = Object.freeze({ ...shipped });
  const shippedFolded = new Set(Object.keys(shippedCopy).map(foldedName));
  if (shippedFolded.size !== Object.keys(shippedCopy).length) throw new CoreError("invalid_input", "shipped publisher names collide case-insensitively");
  const assertNoShadowing = (store: Store) => {
    const names = Object.keys(store.publishers);
    if (names.some(name => shippedFolded.has(foldedName(name)))) {
      throw new CoreError("plugin_refused", "user publisher store shadows a shipped publisher");
    }
    if (new Set(names.map(foldedName)).size !== names.length) {
      throw new CoreError("plugin_refused", "user publisher store has case-colliding publisher names");
    }
  };
  const lookup = (ctx: Ctx, publisher: string): PublisherKey | null => {
    publisherName(publisher);
    const store = load(ctx);
    assertNoShadowing(store);
    const shippedKey = Object.hasOwn(shippedCopy, publisher) ? shippedCopy[publisher] : undefined;
    if (shippedKey) return { key: shippedKey, fingerprint: publisherFingerprint(shippedKey), source: "shipped" };
    const key = Object.hasOwn(store.publishers, publisher) ? store.publishers[publisher] : undefined;
    return key ? { key, fingerprint: publisherFingerprint(key), source: "user" } : null;
  };
  const set = async (ctx: Ctx, publisher: string, key: string | null, expectedFingerprint: string | null) => {
    publisherName(publisher);
    if (key !== null) keyBytes(key);
    if (expectedFingerprint !== null && !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new CoreError("invalid_input", "invalid expected fingerprint");
    assertNoRedirectedParent(ctx.pacerHome); // The shared lock itself writes under this parent.
    return withLock(ctx, "plugins", async () => {
      if (Object.hasOwn(shippedCopy, publisher)) throw new CoreError("not_allowed", "shipped publisher key cannot be changed");
      if (shippedFolded.has(foldedName(publisher))) throw new CoreError("not_allowed", "publisher name collides case-insensitively with a shipped publisher");
      const store = load(ctx);
      assertNoShadowing(store);
      if (Object.keys(store.publishers).some(name => name !== publisher && foldedName(name) === foldedName(publisher))) {
        throw new CoreError("conflict", "publisher name collides case-insensitively with an existing publisher");
      }
      const old = Object.hasOwn(store.publishers, publisher) ? store.publishers[publisher] : undefined;
      const actual = old ? publisherFingerprint(old) : null;
      if (actual !== expectedFingerprint) throw new CoreError("conflict", "publisher fingerprint conflict; review the current key");
      if (key === null) delete store.publishers[publisher];
      else store.publishers[publisher] = key;
      writeStore(ctx, store);
      return { fingerprint: key === null ? null : publisherFingerprint(key) };
    });
  };
  return { lookup, set };
}
export const publisherTrust = createPublisherTrust(shippedPublishers);
