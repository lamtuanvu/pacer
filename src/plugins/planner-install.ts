import { plannerJournalIO } from "./planner-journal";
import { lstatSync } from "node:fs";
import { CoreError } from "../core/errors";
import { withInstallLock } from "../install/lock";
import { validateInstallArgv } from "../install/self";
import { recoverPlannerInstall, plannerTrustedRoots } from "./planner-recovery";
import { readManifest, writeManifest, type PlannerRecord } from "../install/manifest";
import { readInstallFile } from "../install/atomic";
import { clearUndoSnapshot, readSnapshotFile, stageUndoSnapshot, commitStagedUndoSnapshot, discardStagedUndoSnapshot } from "../install/undo-store";
import type { InstallEnv } from "../install/txn";
import { sha256 } from "../install/fsx";
import { commitInstall, type PendingFile } from "../../packages/plugin-sdk/src/install/journal";
import type { PreparedPlannerPlan } from "../../packages/plugin-sdk/src/install/prepared";
import type { InstallReport } from "../../packages/plugin-sdk/src/install/txn";
import { pluginRegistry } from "./index";
import type { PluginRegistry } from "./registry";
import { createCallAuthority } from "./authority";
import { absolutePath, declaredPath } from "./capability-paths";
import { PlannerResources } from "./planner-resources";
import { preparedPlannerPlan } from "./planner-protocol";

/** A repair can be undone for 7 days after the connect that changed files. `ctx.now` is Unix seconds. */
export const UNDO_WINDOW_S = 7 * 86_400;

/** Reported when a connect changed too much total before-content to snapshot, so undo is unavailable. */
export const UNDO_CAP_NOTE =
  "Undo is unavailable for this connect: it changed more data than the snapshot size limit.";

/** Reported when the post-commit snapshot swap missed, so the commit landed but undo is unavailable. */
export const UNDO_SWAP_NOTE =
  "Undo is unavailable for this connect: the saved snapshot could not be finalized.";

/** Restore exactly the files one connect changed, from its snapshot, within the 7-day window. */
export async function restorePlannerInstall(
  ctx: InstallEnv["ctx"],
  agent: string,
  key: string,
  previewRevision?: string,
): Promise<{ restored: string[]; removed: string[]; reverted: string[]; kept: string[] }> {
  return withInstallLock(ctx, async () => {
    // N3: recovery must accept the same folders undo itself uses. Both derive from
    // plannerTrustedRoots (standard agent homes plus every configured account folder);
    // undo never trusts manifest-derived roots the record would have to authorize itself.
    const roots = plannerTrustedRoots(ctx);
    await recoverPlannerInstall(ctx, roots, []);
    const manifest = readManifest(ctx);
    const prior = manifest.planners[key];
    const snap = prior?.undoConnect;
    if (!prior || !snap)
      throw new CoreError("not_found", `No pacer repair is recorded for ${agent}`, "Connect the agent first, then undo a repair from Diagnostics.");
    // N4: the snapshot revision is always set; undo always requires it. A missing or
    // stale revision is refused, even when the connect came from the CLI or setup.
    if (!previewRevision || previewRevision !== snap.revision)
      throw new CoreError("conflict", "The undo target changed after preview", "Review a fresh repair preview before undoing.");
    if (typeof snap.at !== "number" || ctx.now - snap.at > UNDO_WINDOW_S)
      throw new CoreError("not_found", "This repair is older than 7 days and can no longer be undone", "Reconnect the agent from Diagnostics to repair it again.");
    const lease = new PlannerResources(ctx, {
      purpose: "reconcile",
      binaries: [],
      cwd: ctx.home,
      roots,
      files: [],
    });
    try {
      const restored: string[] = [], removed: string[] = [], kept: string[] = [];
      const pending: PendingFile[] = [];
      for (const entry of snap.files) {
        const path = absolutePath(entry.path);
        if (path !== entry.path || !lease.permits(path))
          throw new CoreError("capability_denied", `undo path outside allowed planner folders: ${entry.path}`);
        const text = readInstallFile(path);
        const intact = entry.afterHash === null
          ? text === null
          : text !== null && sha256(text) === entry.afterHash;
        if (!intact) { kept.push(entry.path); continue; }
        if (entry.beforeHash === undefined) {
          if (text !== null)
            pending.push({ path, before: text, after: null, beforeMode: lstatSync(path).mode & 0o700 });
          removed.push(entry.path);
        } else {
          const copy = readSnapshotFile(ctx, key, entry.path, {
            revision: snap.revision,
            beforeHash: entry.beforeHash,
            size: entry.size,
          });
          if (!copy)
            throw new CoreError("not_found", "undo snapshot copy missing for " + entry.path, "Reconnect the agent from Diagnostics to repair it again.");
          pending.push({
            path, before: text, after: copy.text,
            beforeMode: text === null ? undefined : lstatSync(path).mode & 0o700,
            mode: copy.mode,
          });
          restored.push(entry.path);
        }
      }
      const undone = new Set(removed);
      const record = {
        ...prior,
        // Only files that no longer exist leave the record; files restored in place
        // (edited/moved) stay recorded so reconcile sees them as needing a refresh,
        // not as unrecorded files to be replaced.
        files: prior.files.filter((file) => !undone.has(file.path)),
        integration: undefined,
        undoConnect: undefined,
        undoneAt: ctx.now,
      };
      const session = await plannerJournalIO(
        ctx,
        pending,
        Date.now() + 600000,
        () => lease.assertFileRoots(),
      );
      try {
        session.preflight();
        const planners = { ...manifest.planners, [key]: record };
        await commitInstall(
          session.io,
          pending,
          JSON.stringify({ version: 1, planners }, null, 2) + "\n",
        );
      } finally {
        await session.close();
      }
      clearUndoSnapshot(ctx, key);
      return { restored, removed, reverted: [], kept };
    } finally {
      await lease.dispose();
    }
  });
}

export interface PlannerInstallOptions {
  pluginId: string;
  roots: readonly string[];
  files?: readonly string[];
  binaries: readonly string[];
  /** Host-owned test/integration command policy; never sourced from a plugin. */
  commandApproval?: (argv: readonly string[]) => boolean;
  registry?: PluginRegistry;
  signal?: AbortSignal;
  prepareOnly?: boolean;
  beforeCommit?: (plan: PreparedPlannerPlan) => void;
  operation?: "uninstall";
  /** Preview revision the consent was tied to; stored so agent.undo can bind to exactly this connect. */
  undoRevision?: string;
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
    // N1: never send snapshot contents to planner plugins. The snapshot lives in the
    // undo store (the record holds metadata only), but strip the field entirely so a
    // plugin can neither read nor affirm it.
    const pluginPrior = prior
      ? (() => { const copy = structuredClone(prior); delete copy.undoConnect; return copy; })()
      : undefined;
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
      commandApproval: options.commandApproval,
      pacerArgv: options.operation === "uninstall" ? prior?.pacerArgv ?? env.pacerArgv : env.pacerArgv,
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
                ...(pluginPrior ? { prior: pluginPrior } : {}),
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
      // N2: snapshot fields are host-owned. Drop whatever the plugin returned so the
      // host can re-derive them from its own pre-commit reads, on reconcile and
      // no-op connects too, and a forged snapshot can never reach disk.
      if (options.operation !== "uninstall") {
        delete record.undoConnect;
        delete record.undoneAt;
      }
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
      const hostNotes: string[] = [];
      let stagedDir: string | undefined;
      let clearAfterCommit = false;
      try {
        session.preflight();
        const changed = [...pending.values()].filter(
          (file) => file.before !== file.after,
        );
        if (options.operation !== "uninstall") {
          delete record.undoneAt;
          if (env.mode !== "reconcile") {
            if (changed.length) {
              // Stage the new snapshot to a temp dir; swap it into the live key only
              // after the manifest commits, so an aborted commit leaves the prior
              // snapshot's copies intact and still undoable.
              const staged = stageUndoSnapshot(
                ctx,
                env.plannerKey,
                changed.map((file) => ({ path: file.path, before: file.before, mode: file.beforeMode, after: file.after })),
                options.undoRevision,
                ctx.now,
              );
              if (staged) { record.undoConnect = staged.snapshot; stagedDir = staged.dir; }
              else {
                delete record.undoConnect; hostNotes.push(UNDO_CAP_NOTE);
                // No snapshot for this connect; clear the superseded one only
                // after the commit so an aborted commit keeps undo (L3).
                clearAfterCommit = true;
              }
            } else {
              record.undoConnect = prior?.undoConnect ? structuredClone(prior.undoConnect) : undefined;
            }
          } else {
            record.undoConnect = prior?.undoConnect ? structuredClone(prior.undoConnect) : undefined;
          }
        } else {
          // The last snapshot is cleared only after the commit (L3): an aborted
          // commit must keep the prior snapshot's copies for an in-flight undo.
          clearAfterCommit = true;
        }
        const planners = { ...base.planners, [env.plannerKey]: record };
        if (options.operation === "uninstall") delete planners[env.plannerKey];
        await commitInstall(
          session.io,
          changed,
          JSON.stringify({ version: 1, planners }, null, 2) + "\n",
        );
        committed = true;
        // All snapshot cleanup and the swap happen only after the commit. A swap
        // that misses after a successful commit still reports the commit as
        // successful, but with undo unavailable: discard the staged copies and
        // clear the superseded snapshot so no stale snapshot survives (L3).
        try {
          if (stagedDir) commitStagedUndoSnapshot(ctx, env.plannerKey, stagedDir, ctx.now);
          else if (clearAfterCommit) clearUndoSnapshot(ctx, env.plannerKey);
        } catch {
          if (stagedDir) discardStagedUndoSnapshot(stagedDir);
          clearUndoSnapshot(ctx, env.plannerKey);
          // The commit already landed; drop the snapshot reference so undo is
          // reported unavailable rather than surfacing only later as a missing
          // copy. Rewriting the manifest is best-effort and stays under the
          // install lock.
          record.undoConnect = undefined;
          try {
            writeManifest(ctx, { version: 1, planners });
          } catch { /* best-effort */ }
          hostNotes.push(UNDO_SWAP_NOTE);
        }
        return {
          record: structuredClone(record),
          notes: [...plan.notes, ...hostNotes],
          touched: [...plan.touched],
          prepared: structuredClone(plan),
        };
      } finally {
        // A failed commit leaves no orphan copies; the prior snapshot (if any) is
        // preserved on disk and was not replaced by a fresh write.
        if (!committed && stagedDir) discardStagedUndoSnapshot(stagedDir);
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
