import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readJson } from "../fsutil";
import type { Ctx } from "../types";

export interface PluginReload { hash: string; version: string; at: number }
const pathFor = (ctx: Ctx) => join(ctx.pacerHome, "state", "plugin-reload.json");
export function readPluginReload(ctx: Ctx): PluginReload | null {
  const pending = readJson<PluginReload>(pathFor(ctx));
  return pending && /^[a-f0-9]{64}$/.test(pending.hash) && typeof pending.version === "string" && Number.isFinite(pending.at) ? pending : null;
}
export function recordPluginReload(ctx: Ctx, pending: PluginReload): void {
  const path = pathFor(ctx), temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify(pending), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}
