import { installClaude } from "./claude";
import { installCodex } from "./codex";
import { installCursor } from "./cursor";
import { installOpencode } from "./opencode";
import { runInstall, type InstallEnv } from "./txn";
import type { UninstallReport } from "./uninstall";

export const INSTALLERS = {
  "claude-code": (env: InstallEnv) => runInstall(env, "claude-code", installClaude),
  codex: (env: InstallEnv) => runInstall(env, "codex", installCodex),
  cursor: (env: InstallEnv) => runInstall(env, "cursor", installCursor),
  opencode: installOpencode,
};

export function installPlanner(env: InstallEnv, planner: keyof typeof INSTALLERS) {
  return INSTALLERS[planner](env);
}

export function renderInstall(report: Awaited<ReturnType<typeof installPlanner>>): string {
  const lines = report.touched.length
    ? report.record.files.filter(file => report.touched.includes(file.path))
      .map(file => `${file.action} ${file.path}${file.backup ? ` (backup: ${file.backup})` : ""}`)
    : report.notes.some(note => /MCP server|failed/.test(note)) ? [] : ["already installed, nothing changed"];
  lines.push(...report.notes, `Undo with: pacer uninstall ${report.record.planner}`);
  return lines.join("\n");
}

export function renderUninstall(report: UninstallReport): string {
  return [
    ...report.restored.map(path => `restored ${path}`),
    ...report.removed.map(path => `removed ${path}`),
    ...report.reverted.map(path => `reverted ${path}`),
    ...report.notes,
  ].join("\n");
}
