import { hostFingerprint as driftFingerprint, mappedRepoForPath, matchesHostFingerprint } from "./host-drift";
import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostAttemptPreflightGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string;
  taskId: string;
  taskRev: number;
  runFingerprint: string;
  hostFingerprint: string;
  alias: string;
  args: readonly string[];
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostAttemptPreflightGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured attempt preflight changed or was not issued"); };

function snapshot(ctx: Ctx, taskId: string, attempt: number) {
  const task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || !Number.isSafeInteger(attempt) || attempt < 1 ||
    run.mode !== "new" || run.attempt !== attempt || !run.host ||
    !run.remoteWorktree || !isAbsolute(run.remoteWorktree) ||
    normalize(run.remoteWorktree) !== run.remoteWorktree || run.remoteWorktree.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(run.remoteWorktree) ||
    !run.baseSha || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(run.baseSha) ||
    !run.remoteBranch || !/^pacer\/[A-Za-z0-9._/-]+$/.test(run.remoteBranch) ||
    run.remoteBranch.includes("..") || run.remoteBranch.includes("//")) return deny();
  const host = loadStrategy(ctx).hosts[run.host];
  if (!host || host.paused) return deny();
  return { task, run, host };
}

/** Issue the post-exit read-only commit check for one persisted remote attempt. */
export function issueConfiguredHostAttemptPreflight(ctx: Ctx, taskId: string,
  attempt: number): ConfiguredHostAttemptPreflightGrant {
  const current = snapshot(ctx, taskId, attempt);
  const alias = current.run.host!, hostFingerprint = driftFingerprint(current.host, [mappedRepoForPath(current.host, current.run.remoteWorktree!) ?? ""]);
  const args = Object.freeze([current.run.remoteWorktree!, current.run.baseSha!, current.run.remoteBranch!]);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "PREFLIGHT", args: [...args], timeoutMs: 60_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, taskId, taskRev: current.task.rev,
    runFingerprint: JSON.stringify(current.run), hostFingerprint, alias, args, consumed: false });
  return grant;
}

export function validateConfiguredHostAttemptPreflight(ctx: Ctx, grant: ConfiguredHostAttemptPreflightGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const attempt = readTask(ctx, saved.taskId)?.run?.attempt;
  if (attempt === undefined) return deny();
  const current = snapshot(ctx, saved.taskId, attempt);
  if (current.task.rev !== saved.taskRev || JSON.stringify(current.run) !== saved.runFingerprint ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false || current.run.host !== saved.alias ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "PREFLIGHT" || grant.resource.timeoutMs !== 60_000 ||
    grant.resource.maxBytes !== 65_536 || grant.resource.args.length !== 3 ||
    grant.resource.args.some((value, index) => value !== saved.args[index])) return deny();
}

export function consumeConfiguredHostAttemptPreflight(ctx: Ctx, grant: ConfiguredHostAttemptPreflightGrant): void {
  validateConfiguredHostAttemptPreflight(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
