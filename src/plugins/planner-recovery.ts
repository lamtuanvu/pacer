import { recoverLegacyPluginJournal } from "../install/legacy-plugin-undo";
import { dirname, join } from "node:path";
import { lstatSync } from "node:fs";
import { readInstallFile } from "../install/atomic";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { accountFolder } from "../install/role";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import {
  parseInstallJournal,
  recoverInstall,
} from "../../packages/plugin-sdk/src/install/journal";
import { plannerJournalIO } from "./planner-journal";
import { PlannerResources } from "./planner-resources";
import { plannerSelectedSources } from "./planner-selection";
/** The planner roots trust: standard agent homes plus every configured account folder. */
export function plannerTrustedRoots(
  ctx: Ctx,
  trustedRoots: readonly string[] = [],
  trustedFiles: readonly string[] = [],
): string[] {
  const roots = [
    ...trustedRoots,
    join(ctx.home, ".claude"),
    join(ctx.home, ".codex"),
    join(ctx.home, ".cursor"),
    join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "opencode"),
    ...(ctx.env.CODEX_HOME ? [ctx.env.CODEX_HOME] : []),
  ];
  try {
    for (const account of Object.values(loadStrategy(ctx).accounts)) {
      const folder = accountFolder(ctx, account);
      if (folder) roots.push(folder);
    }
  } catch (error) {
    if (!(error instanceof MissingStrategyError)) throw error;
  }
  for (const file of trustedFiles) {
    for (let path = dirname(file); ; path = dirname(path)) {
      try {
        if (lstatSync(path).isDirectory()) { roots.push(path); break; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (path === dirname(path)) break;
    }
  }
  return roots;
}

/** Caller holds the bakery lock. Recovery depends on host state, never plugin presence. */
export async function recoverPlannerInstall(
  ctx: Ctx,
  trustedRoots: readonly string[] = [],
  trustedFiles: readonly string[] = [],
): Promise<void> {
  const text = readInstallFile(join(ctx.pacerHome, "install-transaction.json"));
  if (text === null) return;
  if (await recoverLegacyPluginJournal(ctx)) return;
  const journal = parseInstallJournal(text),
    roots = plannerTrustedRoots(ctx, trustedRoots, trustedFiles);
  const files = [
    ...trustedFiles,
    ...plannerSelectedSources(ctx, "claude-code", join(ctx.home, ".claude")),
  ];
  const lease = new PlannerResources(ctx, {
    purpose: "reconcile",
    binaries: [],
    cwd: ctx.home,
    roots,
    files,
  });
  try {
    for (const file of journal.files)
      if (!lease.permits(file.path))
        throw new CoreError(
          "capability_denied",
          "recovery destination outside trusted planner roots",
        );
    const session = await plannerJournalIO(
      ctx,
      journal.files,
      lease.operationDeadline,
      () => lease.assertFileRoots(),
    );
    try {
      await recoverInstall(session.io);
    } finally {
      await session.close();
    }
  } finally {
    await lease.dispose();
  }
}
