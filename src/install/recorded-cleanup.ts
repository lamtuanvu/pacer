import { join } from "node:path";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import { readManifest } from "./manifest";
import { withInstallLock } from "./lock";
import { recordedAgent } from "./reconcile-target";
import { recoverPlannerInstall } from "../plugins/planner-recovery";
import { PlannerResources } from "../plugins/planner-resources";
import { plannerJournalIO } from "../plugins/planner-journal";
import { createCallAuthority } from "../plugins/authority";
import {
  prepareSpawnAuthority,
  answerSpawn,
  discardSpawnOutput,
} from "../plugins/capability-spawn";
import { plannerCommandIntent } from "../plugins/planner-protocol";
import { preparePlannerUninstallFiles } from "../../packages/plugin-sdk/src/install/uninstall";
import { commitInstall } from "../../packages/plugin-sdk/src/install/journal";

/** Host-owned --all cleanup of stored records; no plugin process or peer-supplied resources. */
export async function cleanupRecordedPlanner(ctx: Ctx, key: string) {
  return await withInstallLock(ctx, async () => {
    await recoverPlannerInstall(ctx);
    const manifest = readManifest(ctx),
      record = manifest.planners[key],
      agent = recordedAgent(key);
    if (!record) return null;
    if (!agent || record.planner !== key)
      throw new CoreError(
        "capability_denied",
        "invalid recorded planner identity",
      );
    const folder =
      record.folder ??
      join(
        ctx.home,
        agent === "claude-code"
          ? ".claude"
          : agent === "opencode"
            ? ".config/opencode"
            : `.${agent}`,
      );
    const paths = [
      ...new Set(
        record.files.flatMap((file) => [
          file.path,
          ...(file.backup ? [file.backup] : []),
        ]),
      ),
    ];
    const lease = new PlannerResources(ctx, {
      purpose: "uninstall",
      binaries: [],
      cwd: ctx.home,
      roots: [folder],
      files: paths,
    });
    const owners: ReturnType<typeof createCallAuthority>[] = [];
    try {
      if (paths.some((path) => !lease.permits(path)))
        throw new CoreError(
          "capability_denied",
          "recorded cleanup outside trusted file policy",
        );
      const undos = record.commands
        .map((value) => value.undo)
        .reverse()
        .filter(
          (argv, index, all) =>
            all.findIndex(
              (other) => JSON.stringify(argv) === JSON.stringify(other),
            ) === index,
        );
      if (
        undos.length > 64 ||
        Buffer.byteLength(JSON.stringify(undos)) > 1048576
      )
        throw new CoreError(
          "too_large",
          "recorded cleanup command budget exceeded",
        );
      // The stored vector supplies arguments, never binary selection or ambient env.
      // Only the agent's host-selected binary can be admitted. No tool-specific fallback.
      const binary = agent === "claude-code" ? "claude" : null,
        selected = binary ? ctx.which(binary) : null;
      const env: Record<string, string> = { HOME: ctx.home };
      for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"])
        if (typeof ctx.env[name] === "string") env[name] = ctx.env[name]!;
      const variable =
        agent === "claude-code"
          ? "CLAUDE_CONFIG_DIR"
          : agent === "codex"
            ? "CODEX_HOME"
            : undefined;
      if (record.configEnv)
        for (const [name, value] of Object.entries(record.configEnv)) {
          if (name !== variable || value !== folder)
            throw new CoreError(
              "capability_denied",
              "recorded cleanup environment conflicts with account",
            );
          env[name] = value;
        }
      const commands = undos.map((argv) => {
        if (
          !binary ||
          !selected ||
          (argv[0] !== binary && argv[0] !== selected) ||
          !plannerCommandIntent.safeParse({ argv, timeoutMs: 30000 }).success
        )
          throw new CoreError(
            "capability_denied",
            "recorded command undo is pending; restore the selected agent CLI and retry uninstall --all. Install record retained",
          );
        const params = {
          argv: [binary, ...argv.slice(1)],
          timeoutMs: 30000,
          cwd: ctx.home,
          env,
        };
        const owner = createCallAuthority(
          { ...ctx, which: (name) => (name === binary ? selected : null) },
          { reads: [], stores: [], commands: [params] },
          { deadlineMs: lease.operationDeadline, grants: ["process.spawn"] },
        );
        owners.push(owner);
        prepareSpawnAuthority(owner);
        return { owner, params };
      });
      const session = await plannerJournalIO(
        ctx,
        paths.map((path) => ({ path, before: null, after: null })),
        lease.operationDeadline,
        () => lease.assertFileRoots(),
      );
      try {
        const preparationFailures: string[] = [];
        const plan = await preparePlannerUninstallFiles(
          { read: async (path) => session.readImage(path) },
          record,
          {
            onIncomplete: (failure) => preparationFailures.push(failure.reason),
          },
        );
        if (preparationFailures.length)
          throw new CoreError(
            "conflict",
            "recorded files could not be restored; install record, files and backups retained. Resolve the occupied destination or missing backup and retry uninstall",
          );
        session.preflight(plan.files);
        const failures: unknown[] = [];
        for (const { owner, params } of commands)
          try {
            const result = (await answerSpawn(owner, [binary!], params)) as {
              code: number;
              timedOut: boolean;
            };
            if (result.code !== 0 || result.timedOut)
              throw new Error("recorded undo exited unsuccessfully");
          } catch (error) {
            failures.push(error);
          } finally {
            discardSpawnOutput(owner);
          }
        if (failures.length) {
          const error = new CoreError(
            "plugin_unavailable",
            "recorded command undo failed; install record and backups retained. Restore the agent CLI and retry pacer uninstall --all --yes",
          );
          Object.defineProperty(error, "cause", {
            value: new AggregateError(failures),
          });
          throw error;
        }
        const planners = { ...manifest.planners };
        delete planners[key];
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
      await Promise.all(owners.map((owner) => owner.revoke()));
      await lease.dispose();
    }
  });
}
