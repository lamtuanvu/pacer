import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostStopGrant { readonly resource: Readonly<HostOperationResource> }

interface Captured {
  home: string;
  alias: string;
  taskId: string;
  taskRev: number;
  runFingerprint: string;
  hostFingerprint: string;
  localDir: string;
  args: readonly string[];
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostStopGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote stop changed or was not issued"); };

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string, graceSeconds: number) {
  const match = /^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/.exec(remoteDir);
  if (!match || !isAbsolute(remoteDir) || !isAbsolute(localDir) ||
    normalize(remoteDir) !== remoteDir || normalize(localDir) !== localDir ||
    !Number.isSafeInteger(graceSeconds) || graceSeconds < 1 || graceSeconds > 60 ||
    [remoteDir, localDir].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) return deny();
  const taskId = match[2]!, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.host !== alias || run.mode !== "new" ||
    run.remoteDir !== remoteDir || run.dir !== localDir || run.attempt !== Number(match[3])) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host) return deny();
  return { taskId, task, host, args: [remoteDir, String(graceSeconds)] };
}

/** Mint only for the current persisted remote run selected for stop. */
export function issueConfiguredHostStop(ctx: Ctx, alias: string, remoteDir: string,
  localDir: string, graceSeconds: number): ConfiguredHostStopGrant {
  const current = snapshot(ctx, alias, remoteDir, localDir, graceSeconds);
  const hostFingerprint = driftFingerprint(current.host), args = Object.freeze(current.args);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "STOP", args: [...args], timeoutMs: (graceSeconds + 10) * 1000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId, taskRev: current.task.rev,
    runFingerprint: JSON.stringify(current.task.run), hostFingerprint, localDir, args, consumed: false });
  return grant;
}

export function validateConfiguredHostStop(ctx: Ctx, grant: ConfiguredHostStopGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.args[0]!, saved.localDir, Number(saved.args[1]));
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false ||
    current.args.length !== saved.args.length || current.args.some((arg, index) => arg !== saved.args[index]) ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "STOP" || grant.resource.timeoutMs !== (Number(saved.args[1]) + 10) * 1000 ||
    grant.resource.maxBytes !== 65_536 || grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((arg, index) => arg !== saved.args[index])) return deny();
}

export function consumeConfiguredHostStop(ctx: Ctx, grant: ConfiguredHostStopGrant): void {
  validateConfiguredHostStop(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
