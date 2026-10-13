import { existsSync, readdirSync, rmdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type InstallEnv, runInstall } from "../install/txn";
import { type UninstallReport, uninstallPlanner } from "../install/uninstall";
import { clearBridge } from "../link/bridge";
import { PLUGIN_KEY } from "../link/envelope";
import { orcaUserDataDir, PLUGIN_RECORD } from "../link/paths";
import type { Ctx } from "../types";
import { PANEL_PLACEHOLDER, PLUGIN_FILES, PLUGIN_VERSION } from "./assets.generated";
import { clearLegacyBridge, legacyPluginInstalled } from "./migration";

export const MANAGED_MARKER = ".pacer-managed";
export const LIVE_PANEL = join("panel", "live.html");
export const pluginDir = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "orca-plugin");

export function marketplacePluginDir(ctx: Pick<Ctx, "home" | "env">): string {
  return join(orcaUserDataDir(ctx), "plugins", PLUGIN_KEY);
}
export function marketplacePluginInstalled(ctx: Pick<Ctx, "home" | "env">): boolean {
  return existsSync(marketplacePluginDir(ctx));
}
export function installSteps(dir: string, marketplace = false): string[] {
  return [
    `pacer Orca plugin ${PLUGIN_VERSION} (${PLUGIN_KEY}) is in ${dir}`,
    "In Orca Settings > Plugins (pacer never edits Orca's settings):",
    marketplace ? "  1. Uninstall the marketplace pacer first." : "  1. Uninstall the marketplace pacer if installed; turn on the plugin system.",
    `  2. Under Development, add ${dir} to the development plugin paths.`,
    '  3. Enable pacer. It asks for: workspace:read, terminal:send, notifications:show, events:subscribe, storage, settings:own; its worker runs as a normal local process.',
    "Orca only refreshes plugin panels added as a development folder, so the live budget panel runs from there.",
  ];
}

export async function installPlugin(env: InstallEnv): Promise<{ text: string }> {
  const dir = resolve(pluginDir(env.ctx));
  const markerPath = join(dir, MANAGED_MARKER);
  let installedAt = new Date().toISOString();
  try { const old = JSON.parse(readFileSync(markerPath, "utf8")); if (typeof old.installedAt === "string" && !Number.isNaN(Date.parse(old.installedAt))) installedAt = old.installedAt; } catch { /* new or legacy marker */ }
  const legacy = legacyPluginInstalled(env.ctx);
  const report = await runInstall(env, PLUGIN_RECORD, tx => {
    for (const f of PLUGIN_FILES) tx.edit(join(dir, f.rel), () => f.text, []);
    tx.edit(join(dir, MANAGED_MARKER), () => `${JSON.stringify({ version: PLUGIN_VERSION, installedAt })}\n`, []);
  });
  if (legacy) report.notes.push("migrated the previous plugin identity to " + PLUGIN_KEY, ...clearLegacyBridge(env.ctx));
  const live = join(dir, LIVE_PANEL);
  if (!existsSync(live)) { mkdirSync(join(dir, "panel"), { recursive: true }); writeFileSync(live, PANEL_PLACEHOLDER); }
  const lines = report.touched.length
    ? report.record.files.filter(f => report.touched.includes(f.path)).map(f => `${f.action} ${f.path}${f.backup ? ` (backup: ${f.backup})` : ""}`)
    : ["already installed, nothing changed"];
  return { text: [...lines, ...report.notes, "", ...installSteps(dir, marketplacePluginInstalled(env.ctx)), "Undo with: pacer plugin uninstall"].join("\n") };
}

export async function uninstallPlugin(ctx: Ctx, platform?: NodeJS.Platform): Promise<UninstallReport | null> {
  const report = await uninstallPlanner(ctx, PLUGIN_RECORD);
  if (!report) return null;
  const dir = pluginDir(ctx), live = join(dir, LIVE_PANEL);
  if (existsSync(live)) { rmSync(live); report.removed.push(live); }
  for (const d of [join(dir, "panel"), join(dir, "assets"), dir]) {
    try { if (existsSync(d) && readdirSync(d).length === 0) rmdirSync(d); } catch { /* keep non-empty */ }
  }
  const c = clearBridge(ctx, platform);
  if (c === "cleared") report.notes.push("removed pacer's link key from Orca plugin storage");
  else if (c !== "skipped") report.notes.push(`left Orca plugin storage unchanged: ${c}`);
  report.notes.push(...clearLegacyBridge(ctx, platform));
  report.notes.push(`Remove ${dir} from Orca's development plugin paths (Settings -> Plugins).`);
  return report;
}
