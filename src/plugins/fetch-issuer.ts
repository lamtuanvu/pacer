import { isAbsolute } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { sshArgv } from "../remote/ssh";
import { SCRIPTS } from "../remote/scripts";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { BundleStageResource } from "./authority";
import { issueBundleStageResource } from "./bundle-stage";

export interface PersistedFetchGrant {
  readonly taskId: string;
  readonly attempt: number;
  readonly taskRev: number;
  readonly repo: string;
  readonly resource: Readonly<BundleStageResource>;
}

interface Captured { home: string; taskId: string; attempt: number; taskRev: number; repo: string;
  alias: string; args: [string, string, string]; resource: BundleStageResource; consumed: boolean }
const issued = new WeakMap<PersistedFetchGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "persisted fetch authority changed or was not issued"); };

/** Host-only: derive the exact bundle source from the durable task/run record. */
export function issuePersistedFetch(ctx: Ctx, taskId: string, attempt: number,
  maxBytes = 50 * 1024 * 1024, timeoutMs = 60_000): PersistedFetchGrant {
  const task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || !Number.isSafeInteger(attempt) || attempt < 1 || run.attempt !== attempt ||
    !isAbsolute(task.brief.repo) || !run.host || !run.remoteWorktree || !isAbsolute(run.remoteWorktree) ||
    !run.baseSha || !run.remoteBranch) return deny();
  const args: [string, string, string] = [run.remoteWorktree, run.baseSha, run.remoteBranch];
  const resource = issueBundleStageResource(ctx, run.host, args, maxBytes, timeoutMs);
  Object.freeze(resource.args); Object.freeze(resource.argv); Object.freeze(resource);
  const grant: PersistedFetchGrant = Object.freeze({ taskId, attempt, taskRev: task.rev,
    repo: task.brief.repo, resource });
  issued.set(grant, { home: ctx.pacerHome, taskId, attempt, taskRev: task.rev,
    repo: task.brief.repo, alias: run.host, args, resource, consumed: false });
  return grant;
}

/** Recheck before provider startup and again before any future claim. */
export function validatePersistedFetch(ctx: Ctx, grant: PersistedFetchGrant): void {
  const saved = issued.get(grant);
  if (!saved || ctx.pacerHome !== saved.home) return deny();
  const task = readTask(ctx, saved.taskId), run = task?.run;
  if (!task || task.rev !== saved.taskRev || task.brief.repo !== saved.repo ||
    !run || run.attempt !== saved.attempt || run.host !== saved.alias ||
    run.remoteWorktree !== saved.args[0] || run.baseSha !== saved.args[1] ||
    run.remoteBranch !== saved.args[2]) return deny();
  const host = loadStrategy(ctx).hosts[saved.alias];
  if (!host || host.paused || JSON.stringify(host) !== saved.resource.hostFingerprint ||
    JSON.stringify(sshArgv(ctx, host, SCRIPTS.BUNDLE_OUT, saved.args)) !== JSON.stringify(saved.resource.argv)) return deny();
}

/** Consume before provider effects; the original object cannot be replayed. */
export function consumePersistedFetch(ctx: Ctx, grant: PersistedFetchGrant): Readonly<BundleStageResource> {
  validatePersistedFetch(ctx, grant);
  const saved = issued.get(grant)!;
  if (saved.consumed) return deny();
  saved.consumed = true;
  return saved.resource;
}
