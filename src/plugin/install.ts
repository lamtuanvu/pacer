import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type UninstallReport, uninstallPlanner } from "../install/uninstall";
import { clearBridge } from "../link/bridge";
import { PLUGIN_RECORD } from "../link/paths";
import type { Ctx } from "../types";

/** The Orca plugin was removed; these names locate leftovers of an earlier install. */
export const LEGACY_PLUGIN_KEY = "pacer.pacer";
const LIVE_PANEL = join("panel", "live.html");
const PANEL_OWNER_MARKER = ".pacer-panel-serve.json";
export const pluginDir = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "orca-plugin");

/** Undo an earlier `pacer plugin install`: restore its recorded files and drop pacer's Orca storage keys. */
export async function uninstallPlugin(ctx: Ctx, platform?: NodeJS.Platform): Promise<UninstallReport | null> {
  const report = await uninstallPlanner(ctx, PLUGIN_RECORD);
  if (!report) return null;
  const dir = pluginDir(ctx);
  for (const path of [join(dir, LIVE_PANEL), join(dir, PANEL_OWNER_MARKER)]) {
    if (existsSync(path)) { rmSync(path); report.removed.push(path); }
  }
  // The worker and the service wrote these; nothing reads them any more.
  for (const path of [join(ctx.pacerHome, "plugin-version.json"), join(ctx.pacerHome, "plugin-live.json"), join(ctx.pacerHome, "state", "plugin-reload.json")]) {
    if (existsSync(path)) { rmSync(path); report.removed.push(path); }
  }
  for (const d of [join(dir, "panel"), join(dir, "assets"), dir]) {
    try { if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d); } catch { /* keep non-empty */ }
  }
  for (const key of [undefined, LEGACY_PLUGIN_KEY]) {
    const c = clearBridge(ctx, platform, key);
    if (c === "cleared") report.notes.push("removed pacer's link key from Orca plugin storage");
    else if (c !== "skipped") report.notes.push(`left Orca plugin storage unchanged: ${c}`);
  }
  report.notes.push(`Remove ${dir} from Orca's development plugin paths (Settings -> Plugins), or uninstall pacer from Orca's marketplace.`);
  return report;
}
