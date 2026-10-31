import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostRuntimeProbeGrant { readonly resource: Readonly<HostOperationResource> }
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
const issued = new WeakMap<ConfiguredHostRuntimeProbeGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote runtime probe changed or was not issued"); };

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string) {
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

/** Mint one fixed platform probe for a persisted full-session remote run. */
export function issueConfiguredHostRuntimeProbe(ctx: Ctx, alias: string, remoteDir: string,
  localDir: string): ConfiguredHostRuntimeProbeGrant {
  const current = snapshot(ctx, alias, remoteDir, localDir);
  const hostFingerprint = driftFingerprint(current.host, []);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "PROBE", args: [], timeoutMs: 60_000, maxBytes: 4096 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId,
    taskRev: current.task.rev, runFingerprint: JSON.stringify(current.task.run), hostFingerprint,
    localDir, remoteDir, consumed: false });
  return grant;
}

export function validateConfiguredHostRuntimeProbe(ctx: Ctx, grant: ConfiguredHostRuntimeProbeGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.remoteDir, saved.localDir);
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "PROBE" || grant.resource.timeoutMs !== 60_000 ||
    grant.resource.maxBytes !== 4096 || grant.resource.args.length !== 0) return deny();
}

export function consumeConfiguredHostRuntimeProbe(ctx: Ctx, grant: ConfiguredHostRuntimeProbeGrant): void {
  validateConfiguredHostRuntimeProbe(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
