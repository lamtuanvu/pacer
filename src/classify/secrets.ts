import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

export function readSecrets(ctx: Ctx): Record<string, string> {
  const path = join(ctx.pacerHome, "secrets");
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (mode & 0o077) {
    throw new Error(`Secrets file must be mode 0600 (is ${mode.toString(8).padStart(4, "0")}); run: chmod 600 ${path}`);
  }
  const secrets: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const name = trimmed.slice(0, separator).trim();
    Object.defineProperty(secrets, name, { value: trimmed.slice(separator + 1).trim(), enumerable: true, configurable: true, writable: true });
  }
  return secrets;
}

export function secret(ctx: Ctx, name: string): string | null {
  if (ctx.env[name]) return ctx.env[name]!;
  const secrets = readSecrets(ctx);
  return (Object.hasOwn(secrets, name) && secrets[name]) || null;
}
