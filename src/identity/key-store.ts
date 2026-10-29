import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Ctx } from "../types";
import { writePrivateFile } from "./atomic";
import { deletePassword, findPassword, writePassword } from "./security";

export type KeyBackend = "keychain" | "file";
export const IDENTITY_DIR = "identity";
export const KEYCHAIN_SERVICE = "pacer";

/** The real path of `path`, resolving the nearest existing ancestor so the answer is the same before and after it is created. */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
}

/**
 * A per-home suffix for machine-wide secrets (Keychain accounts, the install salt), so each PACER_HOME has its own
 * items and a sandbox home never overwrites the real identity. A home copied to another path gets a different tag.
 */
export function homeTag(ctx: Pick<Ctx, "pacerHome">): string {
  return createHash("sha256").update(`pacer-home/v1\0${canonicalPath(ctx.pacerHome)}`).digest("hex").slice(0, 16);
}

/** "staging" holds the new key while a rotation is in progress (see rotate.ts). */
export type KeySlot = "current" | "staging";
const ACCOUNT_PREFIX: Record<KeySlot, string> = { current: "machine-identity", staging: "machine-identity-staging" };
const account = (ctx: Pick<Ctx, "pacerHome">, slot: KeySlot) => `${ACCOUNT_PREFIX[slot]}/${homeTag(ctx)}`;

export function keyBackend(platform: NodeJS.Platform = process.platform): KeyBackend {
  return platform === "darwin" ? "keychain" : "file";
}

const keyPath = (ctx: Ctx, slot: KeySlot) => join(ctx.pacerHome, IDENTITY_DIR, slot === "current" ? "machine.key" : "machine.key.staging");

function fromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export async function readPrivateKey(ctx: Ctx, backend: KeyBackend, slot: KeySlot = "current"): Promise<KeyObject | null> {
  if (backend === "file") {
    if (!existsSync(keyPath(ctx, slot))) return null;
    return fromDer(readFileSync(keyPath(ctx, slot)));
  }
  const hex = await findPassword(ctx, KEYCHAIN_SERVICE, account(ctx, slot));
  return hex === null ? null : fromDer(Buffer.from(hex.trim(), "hex"));
}

/** Store the key and confirm it by reading it back; throws when the stored value is not this key. */
export async function writePrivateKey(ctx: Ctx, backend: KeyBackend, key: KeyObject, slot: KeySlot = "current"): Promise<void> {
  const der = key.export({ format: "der", type: "pkcs8" });
  if (backend === "file") { writePrivateFile(keyPath(ctx, slot), der); return; }
  await writePassword(ctx, KEYCHAIN_SERVICE, account(ctx, slot), der, printed => Buffer.from(printed.trim(), "hex").equals(der));
}

export async function deletePrivateKey(ctx: Ctx, backend: KeyBackend, slot: KeySlot = "current"): Promise<void> {
  if (backend === "file") { rmSync(keyPath(ctx, slot), { force: true }); return; }
  await deletePassword(ctx, KEYCHAIN_SERVICE, account(ctx, slot));
}
