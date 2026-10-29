import { existsSync, readdirSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import {
  runInstall as legacyRun,
  type InstallEnv,
  type Txn,
} from "../src/install/txn";
import type { PlannerBuilder } from "../plugins/pacer-planners/types";
export {
  installClaude,
  editStatuslineScript,
} from "../plugins/pacer-planners/claude";
export { installCodex, codexMcpBlock } from "../plugins/pacer-planners/codex";
export { installCursor } from "../plugins/pacer-planners/cursor";
export { opencodeDir, opencodeConfigPath } from "../src/install/opencode";
import { opencodeDir } from "../src/install/opencode";
import { installOpencodeFiles } from "../plugins/pacer-planners/opencode";
/** Legacy in-process transaction oracle for pure installer fixture comparisons only. */
export async function runInstall(
  env: InstallEnv,
  agent: string,
  installer: (tx: PlannerBuilder) => unknown,
) {
  return legacyRun(env, agent, async (tx: Txn) => {
    const builder = tx as unknown as PlannerBuilder;
    builder.context = {
      home: env.ctx.home,
      env: Object.fromEntries(
        Object.entries(env.ctx.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      binary: env.ctx.which("claude"),
      list: async (dir, glob) =>
        existsSync(dir)
          ? readdirSync(dir)
              .filter((name) => new Bun.Glob(glob).match(name))
              .map((name) => join(dir, name))
          : [],
    };
    builder.runRaw = async (argv) =>
      env.ctx.run(
        argv,
        30000,
        env.configEnv
          ? { env: { ...env.ctx.env, ...env.configEnv } }
          : undefined,
      );
    await installer(builder);
  });
}
export const installOpencode = (env: InstallEnv) =>
  runInstall(
    { ...env, folder: env.folder ?? opencodeDir(env.ctx) },
    "opencode",
    installOpencodeFiles,
  );
export function resolveScript(command: string, home: string): string | null {
  if (!command || /\s/.test(command)) return null;
  const path = command.replace(/^~(?=\/)/, home).replace(/^\$HOME(?=\/)/, home);
  return isAbsolute(path) && existsSync(path) ? path : null;
}

import {
  readManifest,
  writeManifest,
  type PlannerRecord,
} from "../src/install/manifest";
import { readInstallFile, writeInstallFile } from "../src/install/atomic";
import { lstatSync, rmSync } from "node:fs";
import { preparePlannerUninstallFiles } from "../packages/plugin-sdk/src/install/uninstall";
import { removeClaudeMcp } from "../plugins/pacer-planners/claude";
/** Execute shared SDK file undo against isolated unit fixtures; transport ownership is tested separately. */
export async function uninstallPlanner(
  ctx: InstallEnv["ctx"],
  planner: string,
) {
  const manifest = readManifest(ctx),
    record = manifest.planners[planner];
  if (!record) return null;
  const plan = await preparePlannerUninstallFiles(
    {
      read: async (path) => {
        const text = readInstallFile(path);
        return text === null ? null : { text, mode: lstatSync(path).mode };
      },
    },
    record,
  );
  for (const file of plan.files)
    if (file.after === null) rmSync(file.path, { force: true });
    else writeInstallFile(file.path, file.after, file.mode);
  for (const { undo } of [...record.commands].reverse()) {
    if (
      planner.split("#")[0] === "claude-code" &&
      undo[1] === "mcp" &&
      undo[2] === "remove"
    )
      await removeClaudeMcp(
        {
          notes: plan.notes,
          runRaw: (argv) =>
            ctx.run(
              argv,
              30000,
              record.configEnv
                ? { env: { ...ctx.env, ...record.configEnv } }
                : undefined,
            ),
        },
        undo,
      );
    else await ctx.run(undo, 30000);
  }
  delete manifest.planners[planner];
  writeManifest(ctx, manifest);
  plan.uninstallReport.notes = [...plan.notes];
  return plan.uninstallReport;
}
