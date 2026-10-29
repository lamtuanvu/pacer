import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { writePrivateFile } from "./atomic";
import { homeTag, KEYCHAIN_SERVICE, keyBackend } from "./key-store";
import { findPassword, writePassword } from "./security";
import { cachedIdentity, identityPlatform, readMeta } from "./store";

const account = (ctx: Ctx) => `machine-install-salt/${homeTag(ctx)}`;
const saltDir = (ctx: Ctx) => join(ctx.env.XDG_STATE_HOME ?? join(ctx.home, ".local", "state"), "pacer", "install-salt");

/** One salt file per PACER_HOME, outside it, so a copied home finds no salt for its own tag. */
export function saltPath(ctx: Ctx): string {
  return join(saltDir(ctx), homeTag(ctx));
}

/** The install salt, or null when it is missing. Any other failure throws: a read error is not evidence of a copied home. */
export async function readSalt(ctx: Ctx, platform?: NodeJS.Platform): Promise<string | null> {
  if (keyBackend(identityPlatform(platform)) === "file") return existsSync(saltPath(ctx)) ? readFileSync(saltPath(ctx), "utf8").trim() : null;
  return (await findPassword(ctx, KEYCHAIN_SERVICE, account(ctx)))?.trim() ?? null;
}

export const newSalt = () => randomBytes(32).toString("hex");

/** Write a salt (a new one unless given) and confirm it was stored; throws otherwise. */
export async function writeSalt(ctx: Ctx, platform?: NodeJS.Platform, salt = newSalt()): Promise<string> {
  if (keyBackend(identityPlatform(platform)) === "file") writePrivateFile(saltPath(ctx), salt + "\n");
  else await writePassword(ctx, KEYCHAIN_SERVICE, account(ctx), Buffer.from(salt), printed => printed.trim() === salt);
  return salt;
}

export const saltHash = (salt: string) => createHash("sha256").update(salt).digest("hex");

/**
 * True when this home was recorded as copied, or its install salt is missing or does not match.
 * A loaded identity already made this check, so its cached answer is used without reading the Keychain.
 */
export async function cloneSuspected(ctx: Ctx, platform?: NodeJS.Platform): Promise<boolean> {
  const hit = cachedIdentity(ctx);
  if (hit) return hit.cloneSuspected;
  const meta = readMeta(ctx);
  if (meta?.cloneDetected) return true;
  if (!meta?.saltHash) return false;
  const salt = await readSalt(ctx, platform);
  return !salt || saltHash(salt) !== meta.saltHash;
}
