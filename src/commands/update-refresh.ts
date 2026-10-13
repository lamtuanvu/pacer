import { readManifest } from "../install/manifest";
import type { Ctx } from "../types";

/** Run the replacement binary: this process still embeds the previous skill. */
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
      } else lines.push(`${planner}: ${result.stdout.includes("already installed, nothing changed") ? "unchanged" : "refreshed"}`);
    } catch (error) {
      lines.push(`WARNING: ${planner}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}
