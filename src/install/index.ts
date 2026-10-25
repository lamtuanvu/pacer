import { join } from "node:path";
import { allowedPair, type PlannerCfg } from "../config/accounts";
import { loadStrategy } from "../config/strategy";
import { accountFolder } from "./role";
import { plannerSelectedSources } from "../plugins/planner-selection";
import { withPlannerInstall } from "../plugins/planner-install";
import { pluginRegistry } from "../plugins";
import { opencodeDir } from "./opencode";
import { type InstallEnv } from "./txn";
import type { UninstallReport } from "./uninstall";

async function installViaPlugin(env: InstallEnv, agent: string) {
  const folder =
    env.folder ??
    (agent === "opencode"
      ? opencodeDir(env.ctx)
      : join(env.ctx.home, agent === "claude-code" ? ".claude" : `.${agent}`));
  const skillFolder =
    env.skillFolder ?? (agent === "codex" ? env.ctx.env.CODEX_HOME : undefined);
  const selected = { ...env, folder, ...(skillFolder ? { skillFolder } : {}) };
  const id = pluginRegistry(env.ctx).find(
    env.ctx,
    "planner",
    (contribution) =>
      Array.isArray(contribution.agents) && contribution.agents.includes(agent),
  );
  if (!id) throw new Error(`planner plugin unavailable: ${agent}`);
  return await withPlannerInstall(selected, agent, {
    pluginId: id,
    files: plannerSelectedSources(env.ctx, agent, folder),
    roots: [folder, ...(skillFolder ? [skillFolder] : [])],
    binaries:
      agent === "claude-code" &&
      env.mcp !== undefined &&
      env.mode !== "reconcile"
        ? ["claude"]
        : [],
  });
}
export const INSTALLERS = {
  "claude-code": (env: InstallEnv) => installViaPlugin(env, "claude-code"),
  codex: (env: InstallEnv) => installViaPlugin(env, "codex"),
  cursor: (env: InstallEnv) => installViaPlugin(env, "cursor"),
  opencode: (env: InstallEnv) => installViaPlugin(env, "opencode"),
};

export function installPlanner(
  env: InstallEnv,
  planner: keyof typeof INSTALLERS | PlannerCfg,
) {
  if (typeof planner === "string") return INSTALLERS[planner](env);
  if (!Object.hasOwn(INSTALLERS, planner.agent))
    throw new Error(`unsupported planner: ${planner.agent}`);
  const account = loadStrategy(env.ctx).accounts[planner.account];
  if (!account || !allowedPair(planner.agent, account.kind))
    throw new Error(`invalid planner account: ${planner.account}`);
  const folder = accountFolder(env.ctx, account);
  if (account.source === "orca" && !folder)
    throw new Error(`account folder not found: ${planner.account}`);
  const configEnv =
    folder && (planner.agent === "claude-code" || planner.agent === "codex")
      ? {
          [planner.agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]:
            folder,
        }
      : undefined;
  return INSTALLERS[planner.agent as keyof typeof INSTALLERS]({
    ...env,
    folder:
      folder ??
      (planner.agent === "opencode"
        ? opencodeDir(env.ctx)
        : join(
            env.ctx.home,
            planner.agent === "claude-code" ? ".claude" : `.${planner.agent}`,
          )),
    plannerAccount: planner.account,
    plannerKey:
      account.source === "default"
        ? planner.agent
        : `${planner.agent}#${planner.account}`,
    configEnv,
  });
}

export function renderInstall(
  report: Awaited<ReturnType<typeof installPlanner>>,
): string {
  const lines = report.touched.length
    ? report.record.files
        .filter((file) => report.touched.includes(file.path))
        .map(
          (file) =>
            `${file.action} ${file.path}${file.backup ? ` (backup: ${file.backup})` : ""}`,
        )
    : report.notes.some((note) => /MCP server|failed/.test(note))
      ? []
      : ["already installed, nothing changed"];
  lines.push(
    ...report.notes,
    `Undo with: pacer uninstall ${report.record.planner}`,
  );
  return lines.join("\n");
}

export function renderUninstall(report: UninstallReport): string {
  return [
    ...report.restored.map((path) => `restored ${path}`),
    ...report.removed.map((path) => `removed ${path}`),
    ...report.reverted.map((path) => `reverted ${path}`),
    ...report.notes,
  ].join("\n");
}
