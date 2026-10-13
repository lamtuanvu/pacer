import { readManifest } from "../install/manifest";
import { PLUGIN_RECORD } from "../link/paths";
import type { Ctx } from "../types";

/** Run the replacement binary: this process still embeds the previous integration assets. */
export async function refreshIntegrations(ctx: Ctx, path: string): Promise<string[]> {
  const planners = readManifest(ctx).planners;
  const lines: string[] = [];
  for (const planner of ["claude-code", "codex", "cursor", "opencode", PLUGIN_RECORD]) {
    if (!Object.hasOwn(planners, planner)) continue;
    try {
      const result = await ctx.run(planner === PLUGIN_RECORD ? [path, "plugin", "install"] : [path, "install", planner], 30000);
      if (result.code !== 0) {
        const reason = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] || `exit ${result.code}`;
        lines.push(`WARNING: ${planner}: failed: ${reason}`);
      } else {
        const state = result.stdout.includes("already installed, nothing changed") ? "unchanged" : "refreshed";
        const hint = planner === PLUGIN_RECORD && state === "refreshed" ? " (turn pacer off and on in Orca Settings > Plugins to load it)" : "";
        lines.push(`${planner}: ${state}${hint}`);
      }
    } catch (error) {
      lines.push(`WARNING: ${planner}: failed: ${(error instanceof Error ? error.message : String(error)).trim().split(/\r?\n/)[0]}`);
    }
  }
  return lines;
}
