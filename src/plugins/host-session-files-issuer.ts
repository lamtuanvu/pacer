import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { isAbsolute, normalize } from "node:path";
import { cachedStrategy } from "./host-drift";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostSessionFilesGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string;
  alias: string;
  taskId: string;
  taskRev: number;
  runFingerprint: string;
  hostFingerprint: string;
  localDir: string;
  remoteDir: string;
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostSessionFilesGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote session files changed or was not issued"); };

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string) {
  const match = /^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/.exec(remoteDir);
  if (!match || !isAbsolute(remoteDir) || !isAbsolute(localDir) ||
    normalize(remoteDir) !== remoteDir || normalize(localDir) !== localDir ||
    [remoteDir, localDir].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) return deny();
  const taskId = match[2]!, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.host !== alias || run.mode !== "new" ||
    run.remoteDir !== remoteDir || run.dir !== localDir || run.attempt !== Number(match[3])) return deny();
  const host = cachedStrategy(ctx).hosts[alias];
  if (!host || host.session !== "full") return deny();
  return { taskId, task, host };
}

/** Mint only for the exact persisted remote run being observed. */
export function issueConfiguredHostSessionFiles(ctx: Ctx, alias: string, remoteDir: string,
  localDir: string): ConfiguredHostSessionFilesGrant {
  const current = snapshot(ctx, alias, remoteDir, localDir);
  const hostFingerprint = driftFingerprint(current.host);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "SESSION_FILES", args: [remoteDir], timeoutMs: 60_000, maxBytes: 16_384 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId,
    taskRev: current.task.rev, runFingerprint: JSON.stringify(current.task.run), hostFingerprint,
    localDir, remoteDir, consumed: false });
  return grant;
}

export function validateConfiguredHostSessionFiles(ctx: Ctx, grant: ConfiguredHostSessionFilesGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.remoteDir, saved.localDir);
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "SESSION_FILES" || grant.resource.timeoutMs !== 60_000 ||
    grant.resource.maxBytes !== 16_384 || grant.resource.args.length !== 1 ||
    grant.resource.args[0] !== saved.remoteDir) return deny();
}

export function consumeConfiguredHostSessionFiles(ctx: Ctx, grant: ConfiguredHostSessionFilesGrant): void {
  validateConfiguredHostSessionFiles(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
