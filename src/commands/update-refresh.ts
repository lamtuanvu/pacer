import { readManifest } from "../install/manifest";
import type { Ctx } from "../types";
import { existsSync } from "node:fs";
import { strategyPath } from "../config/strategy";
import { migrateStrategy, migrationLines } from "../config/migrate";

export function refreshStrategy(ctx: Ctx): string[] {
  const path = strategyPath(ctx);
  if (!existsSync(path)) return [];
  try { return migrationLines(path, migrateStrategy(path)); }
  catch (e) { return [`WARNING: could not migrate strategy: ${e instanceof Error ? e.message : String(e)}`]; }
}

/** Run the replacement binary: this process still embeds the previous integration assets. */
export async function refreshIntegrations(ctx: Ctx, path: string): Promise<string[]> {
  const planners = readManifest(ctx).planners;
  const lines: string[] = [];
  for (const planner of ["claude-code", "codex", "cursor", "opencode"]) {
    if (!Object.hasOwn(planners, planner)) continue;
    try {
      const result = await ctx.run([path, "install", planner], 30000);
      if (result.code !== 0) {
        const reason = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] || `exit ${result.code}`;
        lines.push(`WARNING: ${planner}: failed: ${reason}`);
      } else {
        const state = result.stdout.includes("already installed, nothing changed") ? "unchanged" : "refreshed";
        lines.push(`${planner}: ${state}`);
      }
    } catch (error) {
      lines.push(`WARNING: ${planner}: failed: ${(error instanceof Error ? error.message : String(error)).trim().split(/\r?\n/)[0]}`);
    }
  }
  return [...lines, ...refreshStrategy(ctx)];
}
