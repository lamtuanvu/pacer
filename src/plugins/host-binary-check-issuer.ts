import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostBinaryCheckGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string;
  alias: string;
  taskId: string;
  taskRev: number;
  runFingerprint: string;
  hostFingerprint: string;
  localDir: string;
  remoteDir: string;
  hash: string;
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostBinaryCheckGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote binary check changed or was not issued"); };

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return deny();
  const match = /^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/.exec(remoteDir);
  if (!match || !isAbsolute(remoteDir) || !isAbsolute(localDir) ||
    normalize(remoteDir) !== remoteDir || normalize(localDir) !== localDir ||
    [remoteDir, localDir].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) return deny();
  const taskId = match[2]!, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.host !== alias || run.mode !== "new" ||
    run.remoteDir !== remoteDir || run.dir !== localDir || run.attempt !== Number(match[3])) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host) return deny();
  return { taskId, task, host };
}

/** Mint one read-only check for a content hash in a persisted remote run. */
export function issueConfiguredHostBinaryCheck(ctx: Ctx, alias: string, remoteDir: string,
  localDir: string, hash: string): ConfiguredHostBinaryCheckGrant {
  const current = snapshot(ctx, alias, remoteDir, localDir, hash);
  const hostFingerprint = driftFingerprint(current.host, []);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "BINARY", args: [hash, "check"], timeoutMs: 60_000, maxBytes: 4096 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId,
    taskRev: current.task.rev, runFingerprint: JSON.stringify(current.task.run), hostFingerprint,
    localDir, remoteDir, hash, consumed: false });
  return grant;
}

export function validateConfiguredHostBinaryCheck(ctx: Ctx, grant: ConfiguredHostBinaryCheckGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.remoteDir, saved.localDir, saved.hash);
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "BINARY" || grant.resource.timeoutMs !== 60_000 ||
    grant.resource.maxBytes !== 4096 || grant.resource.args.length !== 2 ||
    grant.resource.args[0] !== saved.hash || grant.resource.args[1] !== "check") return deny();
}

export function consumeConfiguredHostBinaryCheck(ctx: Ctx, grant: ConfiguredHostBinaryCheckGrant): void {
  validateConfiguredHostBinaryCheck(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
