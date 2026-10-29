import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, RunResult } from "../types";
import { writePrivateFile } from "./atomic";
import { keyBackend } from "./key-store";
import { identityPlatform, readMeta } from "./store";

const ACCOUNT = "machine-install-salt";

export function saltPath(ctx: Ctx): string {
  return join(ctx.env.XDG_STATE_HOME ?? join(ctx.home, ".local", "state"), "pacer", "install-salt");
}

async function security(ctx: Ctx, args: string[], stdin?: string): Promise<RunResult> {
  try { return await ctx.run(["security", ...args], 10000, stdin === undefined ? undefined : { stdin }); }
  catch { throw new Error("machine identity keychain operation failed"); }
}

export async function readSalt(ctx: Ctx, platform?: NodeJS.Platform): Promise<string | null> {
  if (keyBackend(identityPlatform(platform)) === "file") return existsSync(saltPath(ctx)) ? readFileSync(saltPath(ctx), "utf8").trim() : null;
  const r = await security(ctx, ["find-generic-password", "-s", "pacer", "-a", ACCOUNT, "-w"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function writeSalt(ctx: Ctx, platform?: NodeJS.Platform): Promise<string> {
  const salt = randomBytes(32).toString("hex");
  if (keyBackend(identityPlatform(platform)) === "file") writePrivateFile(saltPath(ctx), salt + "\n");
  else await security(ctx, ["-i"], `add-generic-password -U -s pacer -a ${ACCOUNT} -X ${Buffer.from(salt).toString("hex")}\n`);
  return salt;
}

export const saltHash = (salt: string) => createHash("sha256").update(salt).digest("hex");

export async function cloneSuspected(ctx: Ctx, platform?: NodeJS.Platform): Promise<boolean> {
  const meta = readMeta(ctx);
  if (!meta?.saltHash) return false;
  const salt = await readSalt(ctx, platform);
  return !salt || saltHash(salt) !== meta.saltHash;
}
