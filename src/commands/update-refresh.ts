import { recordedAgent } from "../install/reconcile-target";
import type { IntegrationResult } from "../install/reconcile";
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
  if (!Object.keys(readManifest(ctx).planners).some(key => recordedAgent(key))) return refreshStrategy(ctx);
  const lines: string[] = [];
  try {
    const result = await ctx.run([path, "integrations", "refresh", "--json"], 30000);
    let rows: IntegrationResult[];
    try {
      const value: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(value) || value.some(row => !row || typeof row.target !== "string" || !["current", "refreshed", "conflict", "failed"].includes(row.state))) throw Error("invalid result");
      rows = value;
    } catch { throw Error("replacement integration refresh did not return a valid report"); }
    for (const row of rows) {
      const failed = row.state === "failed" || row.state === "conflict";
      lines.push(`${failed ? "WARNING: " : ""}${row.target}: ${row.state}${row.detail ? `: ${row.detail}` : ""}${row.hint ? `. ${row.hint}` : ""}`);
    }
    if (result.code !== 0 && !rows.some(row => row.state === "failed" || row.state === "conflict")) lines.push("WARNING: replacement integration refresh failed; run pacer doctor");
  } catch {
    lines.push("WARNING: could not refresh integrations with the replacement binary; run pacer doctor");
  }
  return [...lines, ...refreshStrategy(ctx)];
}
