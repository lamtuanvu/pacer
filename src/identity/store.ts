import { generateKeyPairSync, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { base32, rawPublicKey } from "./encoding";
import { writePrivateFile } from "./atomic";
import { IDENTITY_DIR, keyBackend, readPrivateKey, writePrivateKey, type KeyBackend } from "./key-store";

export interface MachineMeta { rev: number; name: string; createdAt: number; backend: KeyBackend; rotatedFrom?: string; saltHash?: string }
export interface MachineIdentity { id: string; name: string; rev: number; createdAt: number; publicKey: KeyObject; privateKey: KeyObject }

const cache = new Map<string, MachineIdentity>();
export function clearIdentityCache(): void { cache.clear(); }

let testPlatform: NodeJS.Platform | undefined;
export function setIdentityPlatformForTests(p?: NodeJS.Platform): void { testPlatform = p; }
export function identityPlatform(p?: NodeJS.Platform): NodeJS.Platform { return p ?? testPlatform ?? process.platform; }

const metaPath = (ctx: Ctx) => join(ctx.pacerHome, IDENTITY_DIR, "machine.json");
// Control characters, and bidirectional controls U+202A-U+202E, U+2066-U+2069, U+200E, U+200F.
const STRIP = /[\u0000-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeName(raw: string): string {
  const name = raw.replace(STRIP, "").trim().slice(0, 64);
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
  return { id: base32(rawPublicKey(publicKey)), name: meta.name, rev: meta.rev, createdAt: meta.createdAt, publicKey, privateKey };
}

export async function ensureIdentity(ctx: Ctx, deps: { platform?: NodeJS.Platform } = {}): Promise<MachineIdentity> {
  const hit = cache.get(ctx.pacerHome);
  if (hit) return hit;
  let meta = readMeta(ctx);
  const platform = identityPlatform(deps.platform);
  const backend = meta?.backend ?? keyBackend(platform);
  let privateKey = await readPrivateKey(ctx, backend);
  if (!privateKey || !meta) {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    await writePrivateKey(ctx, backend, privateKey);
    const { writeSalt, saltHash } = await import("./salt");
    const salt = await writeSalt(ctx, platform);
    meta = { rev: 1, name: meta?.name ?? defaultName(), createdAt: ctx.now, backend, saltHash: saltHash(salt) };
    writeMeta(ctx, meta);
  }
  const identity = build(meta, privateKey);
  cache.set(ctx.pacerHome, identity);
  return identity;
}

export function machineView(id: MachineIdentity, cloneSuspected: boolean) {
  return { id: id.id, name: id.name, rev: id.rev, cloneSuspected };
}

export async function setMachineName(ctx: Ctx, name: string, expectRev: number): Promise<MachineMeta> {
  if (ctx.readOnly) throw new CoreError("not_allowed", "pacer is read-only here");
  const clean = sanitizeName(name);
  await ensureIdentity(ctx);
  const meta = readMeta(ctx)!;
  if (meta.rev !== expectRev) throw new CoreError("conflict", "Machine name changed in another client", "Reload and try again.", { expected: expectRev, actual: meta.rev });
  const next = { ...meta, name: clean, rev: meta.rev + 1 };
  writeMeta(ctx, next);
  clearIdentityCache();
  return next;
}
