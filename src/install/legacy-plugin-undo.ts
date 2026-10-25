import { join, resolve, sep } from "node:path";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { PLUGIN_RECORD } from "../link/paths";
import { readManifest } from "./manifest";
import { readInstallFile } from "./atomic";
import { withInstallLock } from "./lock";
import { plannerJournalIO } from "../plugins/planner-journal";
import { PlannerResources } from "../plugins/planner-resources";
import { recoverPlannerInstall } from "../plugins/planner-recovery";
import { preparePlannerUninstallFiles } from "../../packages/plugin-sdk/src/install/uninstall";
import {
  commitInstall,
  parseInstallJournal,
  recoverInstall,
} from "../../packages/plugin-sdk/src/install/journal";

const rootFor = (ctx: Ctx) => resolve(ctx.pacerHome, "orca-plugin");
function allowed(ctx: Ctx, path: string): boolean {
  return path === resolve(path) && path.startsWith(rootFor(ctx) + sep);
}
function roots(ctx: Ctx) {
  // Capture native root identity only. This object is never bound to a peer;
  // private paths remain forbidden by PlannerResources.permits in every purpose.
  return new PlannerResources(ctx, {
    purpose: "reconcile",
    binaries: [],
    cwd: ctx.home,
    roots: [rootFor(ctx)],
  });
}
/** Fixed removed-plugin journal only; journal data cannot select another host root. Caller holds lock. */
export async function recoverLegacyPluginJournal(ctx: Ctx): Promise<boolean> {
  const text = readInstallFile(join(ctx.pacerHome, "install-transaction.json"));
  if (text === null) return false;
  const journal = parseInstallJournal(text);
  if (
    !journal.files.length ||
    !journal.files.every((file) => allowed(ctx, file.path))
  )
    return false;
  const lease = roots(ctx);
  try {
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
  return true;
}
/** Host-only generic SDK undo for the fixed reserved Orca record, never a planner fallback. */
export async function uninstallLegacyPluginRecord(ctx: Ctx) {
  return await withInstallLock(ctx, async () => {
    await recoverPlannerInstall(ctx);
    const manifest = readManifest(ctx),
      record = manifest.planners[PLUGIN_RECORD];
    if (!record) return null;
    if (
      record.planner !== PLUGIN_RECORD ||
      record.commands.length ||
      record.files.some(
        (file) =>
          !allowed(ctx, file.path) ||
          (file.backup && !allowed(ctx, file.backup)),
      )
    )
      throw new CoreError(
        "capability_denied",
        "invalid reserved legacy plugin record",
      );
    const lease = roots(ctx);
    try {
      const paths = [
        ...new Set(
          record.files.flatMap((file) => [
            file.path,
            ...(file.backup ? [file.backup] : []),
          ]),
        ),
      ];
      const session = await plannerJournalIO(
        ctx,
        paths.map((path) => ({ path, before: null, after: null })),
        lease.operationDeadline,
        () => lease.assertFileRoots(),
      );
      try {
        const failures: string[] = [];
        const plan = await preparePlannerUninstallFiles(
          {
            read: async (path) => {
              if (!allowed(ctx, path) || !paths.includes(path))
                throw new CoreError(
                  "capability_denied",
                  "legacy undo outside captured record",
                );
              return session.readImage(path);
            },
          },
          record,
          { onIncomplete: (failure) => failures.push(failure.reason) },
        );
        if (failures.length)
          throw new CoreError(
            "conflict",
            "legacy plugin restore is pending; install record, files and backups retained. Resolve the occupied destination or missing backup and retry pacer plugin uninstall",
          );
        session.preflight(plan.files);
        const planners = { ...manifest.planners };
        delete planners[PLUGIN_RECORD];
        await commitInstall(
          session.io,
          plan.files,
          JSON.stringify({ version: 1, planners }, null, 2) + "\n",
        );
        return plan.uninstallReport;
      } finally {
        await session.close();
      }
    } finally {
      await lease.dispose();
    }
  });
}
