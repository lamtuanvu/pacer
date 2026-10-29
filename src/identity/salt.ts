import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, RunResult } from "../types";
import { writePrivateFile } from "./atomic";
import { homeTag, KEYCHAIN_SERVICE, keyBackend } from "./key-store";
import { identityPlatform, readMeta } from "./store";

const account = (ctx: Ctx) => `machine-install-salt/${homeTag(ctx)}`;
const saltDir = (ctx: Ctx) => join(ctx.env.XDG_STATE_HOME ?? join(ctx.home, ".local", "state"), "pacer", "install-salt");

/** One salt file per PACER_HOME, outside it, so a copied home finds no salt for its own tag. */
export function saltPath(ctx: Ctx): string {
  return join(saltDir(ctx), homeTag(ctx));
}

async function security(ctx: Ctx, args: string[], stdin?: string): Promise<RunResult> {
  try { return await ctx.run(["security", ...args], 10000, stdin === undefined ? undefined : { stdin }); }
  catch { throw new Error("machine identity keychain operation failed"); }
}

export async function readSalt(ctx: Ctx, platform?: NodeJS.Platform): Promise<string | null> {
  if (keyBackend(identityPlatform(platform)) === "file") return existsSync(saltPath(ctx)) ? readFileSync(saltPath(ctx), "utf8").trim() : null;
  const r = await security(ctx, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(ctx), "-w"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function writeSalt(ctx: Ctx, platform?: NodeJS.Platform): Promise<string> {
  const salt = randomBytes(32).toString("hex");
  if (keyBackend(identityPlatform(platform)) === "file") {
    // An earlier development build kept one shared salt file at this path; it is replaced by a directory.
    if (existsSync(saltDir(ctx)) && statSync(saltDir(ctx)).isFile()) rmSync(saltDir(ctx));
    writePrivateFile(saltPath(ctx), salt + "\n");
  } else await security(ctx, ["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account(ctx)} -X ${Buffer.from(salt).toString("hex")}\n`);
  return salt;
}

export const saltHash = (salt: string) => createHash("sha256").update(salt).digest("hex");

export async function cloneSuspected(ctx: Ctx, platform?: NodeJS.Platform): Promise<boolean> {
  const meta = readMeta(ctx);
  if (!meta?.saltHash) return false;
  const salt = await readSalt(ctx, platform);
  return !salt || saltHash(salt) !== meta.saltHash;
}
