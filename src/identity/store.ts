import { generateKeyPairSync, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { withLock } from "../core/lock";
import { base32, rawPublicKey } from "./encoding";
import { writePrivateFile } from "./atomic";
import { IDENTITY_DIR, keyBackend, readPrivateKey, writePrivateKey, type KeyBackend } from "./key-store";

/**
 * `publicId` is the public machine id, kept here so records can be stamped without reading the private key.
 * `cloneDetected` records that this home looked copied (its key or install salt was missing); only rotation clears it.
 * `pendingRotation` exists only while a rotation is in progress; `lastRotation` keeps the signed statement of the last one.
 */
export interface MachineMeta {
  rev: number; name: string; createdAt: number; backend: KeyBackend; publicId?: string; rotatedFrom?: string; saltHash?: string;
  cloneDetected?: boolean; cloneDetectedAt?: number;
  pendingRotation?: { oldId: string; newId: string; signature: string; stagedAt: number };
  lastRotation?: RotationStatement;
}
/** `signature` (base64) is the old key's signature over `oldId 0x00 newId` with plugin id `pacer` and purpose `rotate`. */
export interface RotationStatement { oldId: string; newId: string; signature: string; at: number }
/** `cloneSuspected` is the copied-home check made when the identity was loaded; it is cached with the identity. */
export interface MachineIdentity { id: string; name: string; rev: number; createdAt: number; publicKey: KeyObject; privateKey: KeyObject; cloneSuspected: boolean; lastRotation?: RotationStatement }

/**
 * `stamp` fingerprints machine.json when the identity was cached. Every identity change in any process rewrites
 * machine.json (atomic rename, so a new inode), so a different stamp means another process renamed, rotated or
 * flagged this home and the cached identity is stale.
 */
const cache = new Map<string, { identity: MachineIdentity; stamp: string | null }>();
/** One load per PACER_HOME at a time: concurrent callers share it, so a first start creates one key. */
const inflight = new Map<string, Promise<MachineIdentity>>();
let generation = 0;
/** Cross-process lock for every identity change: creation, rename, rotation and rotation recovery. Not reentrant. */
export const IDENTITY_LOCK = "identity";
export function withIdentityLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> { return withLock(ctx, IDENTITY_LOCK, fn); }
export function clearIdentityCache(): void { cache.clear(); inflight.clear(); generation++; }

function metaStamp(pacerHome: string): string | null {
  try {
    const st = statSync(join(pacerHome, IDENTITY_DIR, "machine.json"), { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
  } catch { return null; }
}

/** The cached identity, if machine.json has not changed since it was cached; a stale entry is dropped. One stat call. */
export function cachedIdentity(ctx: Pick<Ctx, "pacerHome">): MachineIdentity | undefined {
  const hit = cache.get(ctx.pacerHome);
  if (!hit) return undefined;
  if (hit.stamp !== null && hit.stamp === metaStamp(ctx.pacerHome)) return hit.identity;
  cache.delete(ctx.pacerHome);
  return undefined;
}

let testPlatform: NodeJS.Platform | undefined;
export function setIdentityPlatformForTests(p?: NodeJS.Platform): void { testPlatform = p; }
export function identityPlatform(p?: NodeJS.Platform): NodeJS.Platform { return p ?? testPlatform ?? process.platform; }

const metaPath = (ctx: Ctx) => join(ctx.pacerHome, IDENTITY_DIR, "machine.json");
// Control characters; bidirectional controls U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069;
// line and paragraph separators U+2028, U+2029; zero-width U+200B-U+200D and U+FEFF.
const STRIP = /[\u0000-\u001f\u007f-\u009f\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeName(raw: string): string {
  // Cut by code points so a surrogate pair is never split.
  const name = Array.from(raw.replace(STRIP, "").trim()).slice(0, 64).join("").trim();
  if (!name) throw new CoreError("invalid_input", "Machine name is empty", "Use 1-64 visible characters.");
  return name;
}

export function readMeta(ctx: Ctx): MachineMeta | null {
  if (!existsSync(metaPath(ctx))) return null;
  return JSON.parse(readFileSync(metaPath(ctx), "utf8")) as MachineMeta;
}

export function writeMeta(ctx: Ctx, meta: MachineMeta): void {
  writePrivateFile(metaPath(ctx), JSON.stringify(meta, null, 2) + "\n");
}

function defaultName(): string { return `pacer-${base32(randomBytes(3)).slice(0, 4)}`; }

function build(meta: MachineMeta, privateKey: KeyObject): MachineIdentity {
  const publicKey = createPublicKey(privateKey);
  return {
    id: base32(rawPublicKey(publicKey)), name: meta.name, rev: meta.rev, createdAt: meta.createdAt, publicKey, privateKey,
    cloneSuspected: !!meta.cloneDetected, ...(meta.lastRotation ? { lastRotation: meta.lastRotation } : {}),
  };
}

export function ensureIdentity(ctx: Ctx, deps: { platform?: NodeJS.Platform } = {}): Promise<MachineIdentity> {
  const home = ctx.pacerHome, hit = cachedIdentity(ctx);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(home);
  if (running) return running;
  const gen = generation;
  // Stamp inside the lock, after the load's own writes, so no other process can change machine.json in between.
  const p: Promise<MachineIdentity> = withIdentityLock(ctx, async () => ({ identity: await loadIdentityLocked(ctx, deps), stamp: metaStamp(home) }))
    .then(entry => { if (gen === generation) cache.set(home, entry); return entry.identity; })
    .finally(() => { if (inflight.get(home) === p) inflight.delete(home); });
  inflight.set(home, p);
  return p;
}

/** Load, create or recover the identity from disk, bypassing the cache. The caller holds the identity lock. */
export async function loadIdentityLocked(ctx: Ctx, deps: { platform?: NodeJS.Platform } = {}): Promise<MachineIdentity> {
  let meta = readMeta(ctx);
  const platform = identityPlatform(deps.platform);
  if (meta?.pendingRotation) meta = await (await import("./rotate")).recoverRotation(ctx, meta, platform);
  const backend = meta?.backend ?? keyBackend(platform);
  let privateKey = await readPrivateKey(ctx, backend);
  const { readSalt, writeSalt, saltHash } = await import("./salt");
  if (meta && !meta.cloneDetected) {
    // Check before creating anything: a copied home finds no key or salt under its own per-home tag.
    const salt = meta.saltHash ? await readSalt(ctx, platform) : undefined;
    const saltBad = salt !== undefined && (!salt || saltHash(salt) !== meta.saltHash);
    if (!privateKey || saltBad) {
      meta = { ...meta, cloneDetected: true, cloneDetectedAt: ctx.now };
      writeMeta(ctx, meta);
    }
  }
  if (!privateKey || !meta) {
    // Transport keys certified by another machine's key are not this machine's.
    if (meta) (await import("./sign")).clearTransportKeys(ctx);
    privateKey = generateKeyPairSync("ed25519").privateKey;
    await writePrivateKey(ctx, backend, privateKey);
    const salt = await writeSalt(ctx, platform);
    meta = meta
      ? { ...meta, rev: meta.rev + 1, createdAt: ctx.now, saltHash: saltHash(salt) }
      : { rev: 1, name: defaultName(), createdAt: ctx.now, backend, saltHash: saltHash(salt) };
  }
  const identity = build(meta, privateKey);
  if (meta.publicId !== identity.id) writeMeta(ctx, { ...meta, publicId: identity.id });
  return identity;
}

/**
 * The machine id for stamping records: the cached identity while machine.json is unchanged, else `publicId` from it.
 * Never creates an identity or reads the private key, so it is safe on hot paths.
 */
export function cachedMachineId(ctx: Ctx): string | undefined {
  const hit = cachedIdentity(ctx);
  if (hit) return hit.id;
  try { return readMeta(ctx)?.publicId; } catch { return undefined; }
}

/** After a rotation, `rotatedFrom` and `rotationSignature` repeat the old key's signed statement (public data). */
export function machineView(id: MachineIdentity, cloneSuspected: boolean) {
  const last = id.lastRotation?.newId === id.id ? id.lastRotation : undefined;
  return { id: id.id, name: id.name, rev: id.rev, cloneSuspected, ...(last ? { rotatedFrom: last.oldId, rotationSignature: last.signature } : {}) };
}

export async function setMachineName(ctx: Ctx, name: string, expectRev: number): Promise<MachineMeta> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  const clean = sanitizeName(name);
  return withIdentityLock(ctx, async () => {
    await loadIdentityLocked(ctx);
    const meta = readMeta(ctx)!;
    if (meta.rev !== expectRev) throw new CoreError("conflict", "Machine name changed in another client", "Reload and try again.", { expected: expectRev, actual: meta.rev });
    const next = { ...meta, name: clean, rev: meta.rev + 1 };
    writeMeta(ctx, next);
    clearIdentityCache();
    return next;
  });
}
