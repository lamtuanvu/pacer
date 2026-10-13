import { join } from "node:path";
import { readText } from "../install/fsx";
import { readManifest } from "../install/manifest";
import { clearBridge } from "../link/bridge";
import { PLUGIN_RECORD } from "../link/paths";
import type { Ctx } from "../types";

export const LEGACY_PLUGIN_KEY = "pacer.pacer";

/** Older CLI installs use the same folder and install record as the new identity. */
export function legacyPluginInstalled(ctx: Ctx): boolean {
  if (!readManifest(ctx).planners[PLUGIN_RECORD]) return false;
  const dir = join(ctx.pacerHome, "orca-plugin");
  if (readText(join(dir, ".pacer-managed"))?.trim() === LEGACY_PLUGIN_KEY) return true;
  try {
    const manifest = JSON.parse(readText(join(dir, "orca-plugin.json")) ?? "null");
    return manifest?.publisher === "pacer" && manifest?.id === "pacer";
  } catch { return false; }
}

export function clearLegacyBridge(ctx: Ctx, platform?: NodeJS.Platform): string[] {
  const result = clearBridge(ctx, platform, LEGACY_PLUGIN_KEY);
  if (result === "skipped") return [];
  return [result === "cleared" ? "removed the legacy plugin's link key from Orca storage" : `left legacy Orca plugin storage unchanged: ${result}`];
}
