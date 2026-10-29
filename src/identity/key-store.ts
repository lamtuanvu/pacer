import { createPrivateKey, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Ctx, RunResult } from "../types";
import { writePrivateFile } from "./atomic";

export type KeyBackend = "keychain" | "file";
export const IDENTITY_DIR = "identity";
const SERVICE = "pacer", ACCOUNT = "machine-identity";

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
  const r = await security(ctx, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
  if (r.code === 44) return null;
  if (r.code !== 0) throw new Error("machine identity keychain read failed");
  return fromDer(Buffer.from(r.stdout.trim(), "hex"));
}

export async function writePrivateKey(ctx: Ctx, backend: KeyBackend, key: KeyObject): Promise<void> {
  const der = key.export({ format: "der", type: "pkcs8" });
  if (backend === "file") { writePrivateFile(keyPath(ctx), der); return; }
  await security(ctx, ["-i"], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -X ${der.toString("hex")}\n`);
  const check = await security(ctx, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  if (check.code !== 0) throw new Error("machine identity keychain write failed");
}

export async function deletePrivateKey(ctx: Ctx, backend: KeyBackend): Promise<void> {
  if (backend === "file") { rmSync(keyPath(ctx), { force: true }); return; }
  const r = await security(ctx, ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  if (r.code !== 0 && r.code !== 44) throw new Error("machine identity keychain delete failed");
}
