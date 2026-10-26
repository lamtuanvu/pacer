import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostReadFromGrant { readonly resource: Readonly<HostOperationResource> }
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
const issued = new WeakMap<ConfiguredHostReadFromGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote read changed or was not issued"); };

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string,
  stream: string, offset: number, length: number) {
  const match = /^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/.exec(remoteDir);
  if (!match || !isAbsolute(remoteDir) || !isAbsolute(localDir) ||
    normalize(remoteDir) !== remoteDir || normalize(localDir) !== localDir ||
    [remoteDir, localDir].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) ||
    !["stdout", "stderr", "session.raw", "session.log", "session.log.1", "session.ckpt", "session.state"].includes(stream) ||
    !Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(length) || length < 1 || length > 262_144 ||
    !Number.isSafeInteger(offset + length)) return deny();
  const taskId = match[2]!, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.host !== alias || run.mode !== "new" ||
    run.remoteDir !== remoteDir || run.dir !== localDir || run.attempt !== Number(match[3])) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || (["session.log", "session.log.1", "session.ckpt", "session.state"].includes(stream) && host.session !== "full")) return deny();
  return { taskId, task, host, args: [remoteDir, stream, String(offset), String(length), "hex"] };
}

/** Grant exactly one bounded hex range of the persisted remote run. */
export function issueConfiguredHostReadFrom(ctx: Ctx, alias: string, remoteDir: string,
  localDir: string, stream: "stdout" | "stderr" | "session.raw" | "session.log" | "session.log.1" | "session.ckpt" | "session.state",
  offset: number, length: number): ConfiguredHostReadFromGrant {
  const current = snapshot(ctx, alias, remoteDir, localDir, stream, offset, length);
  const hostFingerprint = JSON.stringify(current.host);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "READ_FROM", args: [...current.args], timeoutMs: 60_000, maxBytes: 524_288 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId,
    taskRev: current.task.rev, runFingerprint: JSON.stringify(current.task.run), hostFingerprint,
    localDir, args: Object.freeze(current.args), consumed: false });
  return grant;
}

export function validateConfiguredHostReadFrom(ctx: Ctx, grant: ConfiguredHostReadFromGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.args[0]!, saved.localDir,
    saved.args[1]!, Number(saved.args[2]), Number(saved.args[3]));
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint ||
    JSON.stringify(current.host) !== saved.hostFingerprint ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "READ_FROM" || grant.resource.timeoutMs !== 60_000 ||
    grant.resource.maxBytes !== 524_288 || grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((arg, index) => arg !== saved.args[index])) return deny();
}

export function consumeConfiguredHostReadFrom(ctx: Ctx, grant: ConfiguredHostReadFromGrant): void {
  validateConfiguredHostReadFrom(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
