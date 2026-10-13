import { existsSync, readdirSync, rmdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type InstallEnv, runInstall } from "../install/txn";
import { type UninstallReport, uninstallPlanner } from "../install/uninstall";
import { clearBridge } from "../link/bridge";
import { PLUGIN_KEY } from "../link/envelope";
import { PLUGIN_RECORD } from "../link/paths";
import type { Ctx } from "../types";
import { PANEL_PLACEHOLDER, PLUGIN_FILES, PLUGIN_VERSION } from "./assets.generated";
import { clearLegacyBridge, legacyPluginInstalled } from "./migration";

export const MANAGED_MARKER = ".pacer-managed";
export const LIVE_PANEL = join("panel", "live.html");
export const pluginDir = (ctx: Pick<Ctx, "pacerHome">) => join(ctx.pacerHome, "orca-plugin");

export function installSteps(dir: string): string[] {
  return [
    `pacer Orca plugin ${PLUGIN_VERSION} (${PLUGIN_KEY}) is in ${dir}`,
    "To load it in Orca (pacer never edits Orca's settings):",
    "  1. Orca -> Settings -> Plugins: turn on the plugin system.",
    `  2. Add ${dir} to the development plugin paths (use a development path, not "Install plugin": the budget panel rewrites itself).`,
    "  3. Review and enable \"pacer\". It asks for: workspace:read, terminal:send, notifications:show, events:subscribe, storage, settings:own; its worker runs as a normal local process.",
    "  4. Run `pacer console --open` (and optionally `pacer serve`) so the plugin can reach the brain.",
  ];
}

export async function installPlugin(env: InstallEnv): Promise<{ text: string }> {
  const dir = pluginDir(env.ctx);
  const legacy = legacyPluginInstalled(env.ctx);
  const report = await runInstall(env, PLUGIN_RECORD, tx => {
    for (const f of PLUGIN_FILES) tx.edit(join(dir, f.rel), () => f.text, []);
    tx.edit(join(dir, MANAGED_MARKER), () => `${PLUGIN_KEY}\n`, []);
  });
  if (legacy) report.notes.push("migrated the previous plugin identity to " + PLUGIN_KEY, ...clearLegacyBridge(env.ctx));
  const live = join(dir, LIVE_PANEL);
  if (!existsSync(live)) { mkdirSync(join(dir, "panel"), { recursive: true }); writeFileSync(live, PANEL_PLACEHOLDER); }
  const lines = report.touched.length
    ? report.record.files.filter(f => report.touched.includes(f.path)).map(f => `${f.action} ${f.path}${f.backup ? ` (backup: ${f.backup})` : ""}`)
    : ["already installed, nothing changed"];
  return { text: [...lines, ...report.notes, "", ...installSteps(dir), "Undo with: pacer plugin uninstall"].join("\n") };
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
