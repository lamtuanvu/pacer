import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Ctx, RunResult } from "../types";
import { writePrivateFile } from "./atomic";

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
export function homeTag(ctx: Ctx): string {
  return createHash("sha256").update(`pacer-home/v1\0${canonicalPath(ctx.pacerHome)}`).digest("hex").slice(0, 16);
}

const account = (ctx: Ctx) => `machine-identity/${homeTag(ctx)}`;

export function keyBackend(platform: NodeJS.Platform = process.platform): KeyBackend {
  return platform === "darwin" ? "keychain" : "file";
}

const keyPath = (ctx: Ctx) => join(ctx.pacerHome, IDENTITY_DIR, "machine.key");

async function security(ctx: Ctx, args: string[], stdin?: string): Promise<RunResult> {
  try { return await ctx.run(["security", ...args], 10000, stdin === undefined ? undefined : { stdin }); }
  catch { throw new Error("machine identity keychain operation failed"); }
}

function fromDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

export async function readPrivateKey(ctx: Ctx, backend: KeyBackend): Promise<KeyObject | null> {
  if (backend === "file") {
    if (!existsSync(keyPath(ctx))) return null;
    return fromDer(readFileSync(keyPath(ctx)));
  }
  const r = await security(ctx, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(ctx), "-w"]);
  if (r.code === 44) return null;
  if (r.code !== 0) throw new Error("machine identity keychain read failed");
  return fromDer(Buffer.from(r.stdout.trim(), "hex"));
}

export async function writePrivateKey(ctx: Ctx, backend: KeyBackend, key: KeyObject): Promise<void> {
  const der = key.export({ format: "der", type: "pkcs8" });
  if (backend === "file") { writePrivateFile(keyPath(ctx), der); return; }
  await security(ctx, ["-i"], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account(ctx)} -X ${der.toString("hex")}\n`);
  const check = await security(ctx, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(ctx)]);
  if (check.code !== 0) throw new Error("machine identity keychain write failed");
}

export async function deletePrivateKey(ctx: Ctx, backend: KeyBackend): Promise<void> {
  if (backend === "file") { rmSync(keyPath(ctx), { force: true }); return; }
  const r = await security(ctx, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account(ctx)]);
  if (r.code !== 0 && r.code !== 44) throw new Error("machine identity keychain delete failed");
}
