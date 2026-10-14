import type { PlannerCfg } from "../config/accounts";
import { removeClaudeMcp } from "./claude";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Ctx } from "../types";
import { readText, sha256, shellCommand } from "./fsx";
import { applyUndo, readManifest, writeManifest } from "./manifest";

export interface UninstallReport { planner: string; restored: string[]; removed: string[]; reverted: string[]; notes: string[] }
export async function uninstallPlanner(ctx: Ctx, planner: string | PlannerCfg): Promise<UninstallReport | null> {
  const manifest = readManifest(ctx);
  if (typeof planner !== "string") {
    const selected = planner;
    const key = `${selected.agent}#${selected.account}`;
    planner = manifest.planners[key] ? key : manifest.planners[selected.agent]?.account === selected.account ? selected.agent : key;
  }
  const record = manifest.planners[planner];
  if (!record) return null;
  const report: UninstallReport = { planner, restored: [], removed: [], reverted: [], notes: [] };
  for (const file of [...record.files].reverse()) {
    try {
      if (file.action === "moved") {
        if (file.backup && existsSync(file.backup) && !existsSync(file.path)) {
          renameSync(file.backup, file.path); report.restored.push(file.path);
        } else report.notes.push(`cannot restore ${file.path}; backup kept at ${file.backup}`);
        continue;
      }
      const text = readText(file.path);
      const intact = text !== null && sha256(text) === file.afterHash;
      if (file.action === "created" && intact) {
        rmSync(file.path); report.removed.push(file.path);
      } else if (file.action === "edited" && intact && file.exact && file.backup && existsSync(file.backup)) {
        copyFileSync(file.backup, file.path); rmSync(file.backup); report.restored.push(file.path);
      } else {
        if (text !== null && file.undo.length) {
          writeFileSync(file.path, applyUndo(text, file.undo, report.notes)); report.reverted.push(file.path);
        } else report.notes.push(`left ${file.path} unchanged`);
        if (file.backup) report.notes.push(`backup kept at ${file.backup}`);
      }
    } catch (error) {
      report.notes.push(`cannot revert ${file.path}: ${error instanceof Error ? error.message : String(error)}${file.backup ? `; backup kept at ${file.backup}` : ""}`);
    }
  }
  for (const { undo } of [...record.commands].reverse()) {
    if (planner.split("#")[0] === "claude-code" && undo[1] === "mcp" && undo[2] === "remove") {
      await removeClaudeMcp(ctx, undo, report.notes, record.configEnv);
      continue;
    }
    try {
      const result = await ctx.run(undo, 30000, record.configEnv ? {env: {...ctx.env, ...record.configEnv}} : undefined);
      if (result.code !== 0) report.notes.push(`\`${shellCommand(undo)}\` failed (exit ${result.code}): ${(result.stderr || result.stdout).split(/\r?\n/)[0]}`);
    } catch (error) { report.notes.push(`\`${shellCommand(undo)}\` failed: ${String(error)}`); }
  }
  delete manifest.planners[planner];
  writeManifest(ctx, manifest);
  return report;
}
