import { join } from "node:path";
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
/** Caller holds the bakery lock. Recovery depends on host state, never plugin presence. */
export async function recoverPlannerInstall(
  ctx: Ctx,
  trustedRoots: readonly string[] = [],
  trustedFiles: readonly string[] = [],
): Promise<void> {
  const text = readInstallFile(join(ctx.pacerHome, "install-transaction.json"));
  if (text === null) return;
  const journal = parseInstallJournal(text),
    roots = [
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
