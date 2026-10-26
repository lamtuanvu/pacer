import { PLUGIN_RECORD } from "../link/paths";
import { uninstallLegacyPluginRecord } from "./legacy-plugin-undo";
import { withInstallLock } from "./lock";
import { recoverPlannerInstall } from "../plugins/planner-recovery";
import { join } from "node:path";
import type { PlannerCfg } from "../config/accounts";
import type { Ctx } from "../types";
import { readManifest } from "./manifest";
import { withPlannerInstall } from "../plugins/planner-install";
import { pluginRegistry } from "../plugins";
import {
  preparePlannerUninstallFiles,
  type PreparedPlannerUninstall,
  type UninstallReport,
} from "../../packages/plugin-sdk/src/install/uninstall";
export type { UninstallReport } from "../../packages/plugin-sdk/src/install/uninstall";
/** Generic host-owned schema1 file recovery remains available without the plugin. */
export async function uninstallPlanner(
  ctx: Ctx,
  selection: string | PlannerCfg,
): Promise<UninstallReport | null> {
  if (selection === PLUGIN_RECORD) return await uninstallLegacyPluginRecord(ctx);
  await withInstallLock(ctx, () => recoverPlannerInstall(ctx));
  const manifest = readManifest(ctx);
  const planner =
    typeof selection === "string"
      ? selection
      : manifest.planners[`${selection.agent}#${selection.account}`]
        ? `${selection.agent}#${selection.account}`
        : manifest.planners[selection.agent]?.account === selection.account
          ? selection.agent
          : `${selection.agent}#${selection.account}`;
  const record = manifest.planners[planner];
  if (!record) return null;
  const agent = planner.split("#")[0]!,
    folder =
      record.folder ??
      join(
        ctx.home,
        agent === "claude-code"
          ? ".claude"
          : agent === "opencode"
            ? ".config/opencode"
            : `.${agent}`,
      );
  const registry = pluginRegistry(ctx),
    id = registry.find(
      ctx,
      "planner",
      (value) => Array.isArray(value.agents) && value.agents.includes(agent),
    );
  const report = await withPlannerInstall(
    {
      ctx,
      pacerArgv: [...record.pacerArgv],
      folder,
      plannerKey: planner,
      ...(record.account ? { plannerAccount: record.account } : {}),
      ...(record.configEnv ? { configEnv: { ...record.configEnv } } : {}),
    },
    agent,
    {
      pluginId: id ?? "pacer-planners",
      operation: "uninstall",
      files: record.files.flatMap((file) => [
        file.path,
        ...(file.backup ? [file.backup] : []),
      ]),
      roots: [folder],
      binaries:
        id && record.commands.length && agent === "claude-code"
          ? ["claude"]
          : [],
      registry,
      prepareMissing: async (prior, read) => {
        const plan = await preparePlannerUninstallFiles({ read }, prior);
        if (prior.commands.length)
          throw new Error("recorded command undo is pending; planner plugin unavailable. Restore the planner plugin or retry pacer uninstall --all --yes; the install record was retained");
        plan.uninstallReport.notes = [...plan.notes];
        return plan;
      },
    },
  );
  return (report.prepared as PreparedPlannerUninstall).uninstallReport;
}
