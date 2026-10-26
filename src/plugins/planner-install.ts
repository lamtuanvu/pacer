import { plannerJournalIO } from "./planner-journal";
import { lstatSync } from "node:fs";
import { CoreError } from "../core/errors";
import { withInstallLock } from "../install/lock";
import { validateInstallArgv } from "../install/self";
import { recoverPlannerInstall } from "./planner-recovery";
import { readManifest, type PlannerRecord } from "../install/manifest";
import { readInstallFile } from "../install/atomic";
import type { InstallEnv } from "../install/txn";
import { sha256 } from "../install/fsx";
import { commitInstall } from "../../packages/plugin-sdk/src/install/journal";
import type { PreparedPlannerPlan } from "../../packages/plugin-sdk/src/install/prepared";
import type { InstallReport } from "../../packages/plugin-sdk/src/install/txn";
import { pluginRegistry } from "./index";
import type { PluginRegistry } from "./registry";
import { createCallAuthority } from "./authority";
import { absolutePath, declaredPath } from "./capability-paths";
import { PlannerResources } from "./planner-resources";
import { preparedPlannerPlan } from "./planner-protocol";

export interface PlannerInstallOptions {
  pluginId: string;
  roots: readonly string[];
  files?: readonly string[];
  binaries: readonly string[];
  registry?: PluginRegistry;
  signal?: AbortSignal;
  prepareOnly?: boolean;
  beforeCommit?: (plan: PreparedPlannerPlan) => void;
  operation?: "uninstall";
  prepareMissing?: (
    prior: PlannerRecord,
    read: (path: string) => Promise<{ text: string; mode: number } | null>,
  ) => Promise<PreparedPlannerPlan>;
}
const refused = (message: string): never => {
  throw new CoreError("plugin_refused", message);
};
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Lock owner spans recovery, the actual child call, journal settlement and compensation. */
export async function withPlannerInstall(
  source: InstallEnv,
  planner: string,
  options: PlannerInstallOptions,
): Promise<InstallReport & { prepared: PreparedPlannerPlan }> {
  options = {
    ...options,
    roots: [...options.roots],
    files: options.files ? [...options.files] : undefined,
    binaries: [...options.binaries],
  };
  const selected = new Map(
    options.binaries.map((name) => [name, source.ctx.which(name)]),
  );
  const ctx = {
    ...source.ctx,
    env: structuredClone(source.ctx.env),
    which: (name: string) => selected.get(name) ?? null,
  };
  const env = structuredClone({
    now: ctx.now,
    pacerArgv: source.pacerArgv,
    plannerKey: source.plannerKey ?? planner,
    ...(source.mcp === undefined ? {} : { mcp: source.mcp }),
    ...(source.folder ? { folder: source.folder } : {}),
    ...(source.plannerAccount ? { plannerAccount: source.plannerAccount } : {}),
    ...(source.configEnv ? { configEnv: source.configEnv } : {}),
    ...(source.mode ? { mode: source.mode } : {}),
    ...(source.skillFolder ? { skillFolder: source.skillFolder } : {}),
  });
  validateInstallArgv(ctx.env, env.pacerArgv);
  const action = async () => {
    if (!options.prepareOnly)
      await recoverPlannerInstall(ctx, options.roots, options.files);
    const registry = options.registry ?? pluginRegistry(ctx),
      info = registry
        .list(ctx)
        .find((value) => value.id === options.pluginId && value.enabled);
    if (!info && !options.prepareMissing)
      throw new CoreError(
        "plugin_unavailable",
        "selected planner plugin is unavailable",
      );
    const granted = (name: string) =>
      info?.capabilities.some((capability) => capability.name === name) &&
      (info.bundled || info.grant?.capabilities.includes(name));
    if (info && (!granted("fs.read") || !granted("fs.write")))
      throw new CoreError(
        "capability_denied",
        "planner installation requires declared and granted file capabilities",
      );
    if (info && options.binaries.length && !granted("process.spawn"))
      throw new CoreError(
        "capability_denied",
        "planner commands require declared and granted process capability",
      );
    const scopes = Object.freeze([
      ...(info?.capabilities.find((value) => value.name === "fs.write")
        ?.scopes ?? [
        ...options.roots.map((root) => root + "/**"),
        ...(options.files ?? []),
      ]),
    ]);
    const base = readManifest(ctx),
      prior = base.planners[env.plannerKey];
    const lease = new PlannerResources(ctx, {
      purpose:
        options.operation === "uninstall"
          ? "uninstall"
          : options.prepareOnly
            ? "preview"
            : env.mode === "reconcile"
              ? "reconcile"
              : "install",
      binaries: options.binaries,
      cwd: ctx.home,
      env: {
        ...Object.fromEntries(
          Object.entries(ctx.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        ...env.configEnv,
      },
      roots: options.roots,
      files: options.files,
    });
    const policy = createCallAuthority(
      ctx,
      { reads: [], commands: [], stores: [] },
      {
        deadlineMs: Date.now() + 600000,
        grants: ["fs.write"],
        accountHome: env.folder,
      },
    );
    let committed = false;
    try {
      const result =
        !info &&
        options.operation === "uninstall" &&
        options.prepareMissing &&
        prior
          ? await options.prepareMissing(
              structuredClone(prior),
              async (path) => {
                if (!lease.permits(absolutePath(path)))
                  throw new CoreError(
                    "capability_denied",
                    "recorded uninstall path outside selected roots",
                  );
                const text = readInstallFile(path);
                return text === null
                  ? null
                  : { text, mode: lstatSync(path).mode };
              },
            )
          : await registry.call(
              ctx,
              options.pluginId,
              options.operation === "uninstall"
                ? "planner.uninstall"
                : options.prepareOnly
                  ? "planner.plan"
                  : "planner.install",
              {
                agent: planner,
                home: ctx.home,
                pacerHome: ctx.pacerHome,
                env,
                binary: options.binaries.length
                  ? ctx.which(options.binaries[0]!)
                  : null,
                ...(prior ? { prior: structuredClone(prior) } : {}),
              },
              {
                plannerResources: lease,
                accountHome: env.folder,
                signal: options.signal,
              },
            );
      // registry.call has drained/revoked the peer before returning. Only private owners remain.
      const parsed = preparedPlannerPlan.safeParse(result);
      if (!parsed.success) refused("planner returned invalid preparation data");
      const plan = parsed.data as unknown as PreparedPlannerPlan,
        record = plan.record;
      if (
        !record ||
        typeof record !== "object" ||
        !Array.isArray(record.files) ||
        !Array.isArray(record.commands) ||
        !Array.isArray(record.notes)
      )
        refused("planner record malformed");
      const expected = {
        planner: env.plannerKey,
        installedAt: prior?.installedAt ?? ctx.now,
        pacerArgv: env.pacerArgv,
        account: env.plannerAccount ?? prior?.account,
        folder: env.folder ?? prior?.folder,
        configEnv: env.configEnv ?? prior?.configEnv,
        mcp:
          env.mcp !== undefined && env.mode !== "reconcile"
            ? env.mcp
            : prior?.mcp,
      };
      if (options.operation === "uninstall" && prior)
        Object.assign(expected, {
          account: prior.account,
          folder: prior.folder,
          configEnv: prior.configEnv,
          mcp: prior.mcp,
          pacerArgv: prior.pacerArgv,
        });
      for (const [key, value] of Object.entries(expected))
        if (!equal(record[key as keyof PlannerRecord], value))
          refused("planner changed captured installation identity");
      const commands = structuredClone(prior?.commands ?? []);
      for (const undo of lease.commandUndos())
        if (!commands.some((value) => equal(value.undo, undo)))
          commands.push({ undo });
      if (
        !equal(record.commands, commands) ||
        (options.operation !== "uninstall" && !equal(record.notes, plan.notes))
      )
        refused("planner changed admitted command claims or notes");
      const validPath = (raw: string) => {
        const path = absolutePath(raw);
        if (
          path !== raw ||
          !lease.permits(path) ||
          !declaredPath(policy, scopes, path)
        )
          throw new CoreError(
            "capability_denied",
            "planner destination is outside captured file policy",
          );
        return path;
      };
      const pending = new Map(
        plan.files.map((file) => [validPath(file.path), file]),
      );
      if (pending.size !== plan.files.length)
        refused("planner returned duplicate file destination");
      const associated = new Set<string>();
      for (const file of record.files) {
        if (
          !file ||
          typeof file.path !== "string" ||
          !["created", "edited", "moved"].includes(file.action) ||
          !Array.isArray(file.undo)
        )
          refused("planner file record malformed");
        validPath(file.path);
        associated.add(file.path);
        const change = pending.get(file.path),
          old = prior?.files.find((value) => value.path === file.path);
        if (!change && !old)
          refused("planner file record lacks prepared image");
        if (
          options.operation !== "uninstall" &&
          change &&
          change.after !== null &&
          file.afterHash !== sha256(change.after)
        )
          refused("planner after-image hash mismatch");
        if (file.backup) {
          validPath(file.backup);
          associated.add(file.backup);
          if (!old?.backup) {
            const backup = pending.get(file.backup);
            if (
              !change ||
              !backup ||
              backup.before !== null ||
              backup.after !== change.before ||
              backup.mode !== change.beforeMode
            )
              refused("planner backup association mismatch");
          } else if (file.backup !== old.backup)
            refused("planner replaced prior backup association");
        }
      }
      for (const path of pending.keys())
        if (!associated.has(path))
          refused("planner prepared an unassociated file destination");
      if (
        plan.touched.some(
          (path) =>
            !record.files.some((file) => file.path === path) ||
            !pending.has(path),
        )
      )
        refused("planner touched list does not match preparation");
      for (const file of pending.values()) {
        const image = readInstallFile(file.path);
        if (
          image !== file.before ||
          (image !== null &&
            (lstatSync(file.path).mode & 0o700) !== file.beforeMode)
        )
          throw new CoreError(
            "conflict",
            "installation before-image or mode changed",
          );
      }
      options.beforeCommit?.(plan);
      if (options.prepareOnly)
        return {
          record: structuredClone(record),
          notes: [...plan.notes],
          touched: [...plan.touched],
          prepared: structuredClone(plan),
        };
      const session = await plannerJournalIO(
        ctx,
        [...pending.values()],
        lease.operationDeadline,
        () => lease.assertFileRoots(),
      );
      try {
        session.preflight();
        const planners = { ...base.planners, [env.plannerKey]: record };
        if (options.operation === "uninstall") delete planners[env.plannerKey];
        await commitInstall(
          session.io,
          [...pending.values()].filter(file => file.before !== file.after),
          JSON.stringify({ version: 1, planners }, null, 2) + "\n",
        );
        committed = true;
        return {
          record: structuredClone(record),
          notes: [...plan.notes],
          touched: [...plan.touched],
          prepared: structuredClone(plan),
        };
      } finally {
        await session.close();
      }
    } catch (error) {
      if (!committed) {
        try {
          await lease.rollback();
        } catch (cleanup) {
          const failure = new CoreError(
            "plugin_unavailable",
            "planner installation failed and compensation is incomplete",
            undefined,
            {
              operationErrorCode:
                error instanceof CoreError ? error.code : "plugin_unavailable",
              cleanupErrorCode:
                cleanup instanceof CoreError
                  ? cleanup.code
                  : "plugin_unavailable",
            },
          );
          Object.defineProperty(failure, "cause", {
            value: new AggregateError(
              [error, cleanup],
              "installation and compensation failures",
            ),
          });
          throw failure;
        }
      }
      throw error;
    } finally {
      await policy.revoke();
      await lease.dispose();
    }
  };
  return options.prepareOnly
    ? await action()
    : await withInstallLock(ctx, action);
}
