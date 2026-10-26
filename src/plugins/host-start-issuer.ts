import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostStartGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string; alias: string; taskId: string; taskRev: number; runFingerprint: string;
  hostFingerprint: string; remoteDir: string; localDir: string; args: readonly string[];
  input: Uint8Array; inputHash: string; consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostStartGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured remote start changed or was not issued"); };
export const MAX_START_INPUT = 50 * 1024 * 1024;

function snapshot(ctx: Ctx, alias: string, remoteDir: string, localDir: string, args: readonly string[]) {
  const match = /^(.+)\/\.pacer-remote\/runs\/(t-\d{8}-\d{6}-[0-9a-f]{4})\/([1-9][0-9]*)$/.exec(remoteDir);
  if (!match || !isAbsolute(remoteDir) || !isAbsolute(localDir) || normalize(remoteDir) !== remoteDir ||
    normalize(localDir) !== localDir || args.length < 6 || args.length > 25 ||
    args.some(value => typeof value !== "string" || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) ||
    args[0] !== remoteDir || !isAbsolute(args[1]!) || normalize(args[1]!) !== args[1] ||
    !["full", "pty", "pipe"].includes(args[2]!) ||
    args.indexOf("--") < 3 || args.indexOf("--") >= args.length - 1) return deny();
  const taskId = match[2]!, task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.host !== alias || run.mode !== "new" || run.remoteDir !== remoteDir ||
    run.dir !== localDir || run.workdir !== args[1] || run.attempt !== Number(match[3])) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused || (host.session === "full") !== (args[2] === "full")) return deny();
  const firstEnv = args[2] === "full" ? 4 : 3;
  if (args[2] === "full" && !/^\/.+\/\.pacer-remote\/bin\/[a-f0-9]{64}\/pacer$/.test(args[3]!)) return deny();
  const separator = args.indexOf("--");
  if (args.slice(firstEnv, separator).some(value => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) return deny();
  return { taskId, task, host };
}

/** Mint one exact START with private bytes, after the attempt has persisted its run. */
export function issueConfiguredHostStart(ctx: Ctx, alias: string, remoteDir: string, localDir: string,
  args: readonly string[], input: Uint8Array): ConfiguredHostStartGrant {
  if (!(input instanceof Uint8Array) || input.length < 1 || input.length > MAX_START_INPUT ||
    !Buffer.from(input).includes(Buffer.from("__PACER_STDIN__\n"))) return deny();
  const current = snapshot(ctx, alias, remoteDir, localDir, args);
  const hostFingerprint = JSON.stringify(current.host), fixed = Object.freeze([...args]);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint, script: "START",
    args: [...fixed], timeoutMs: 60_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  const bytes = Uint8Array.from(input);
  issued.set(grant, { home: ctx.pacerHome, alias, taskId: current.taskId, taskRev: current.task.rev,
    runFingerprint: JSON.stringify(current.task.run), hostFingerprint, remoteDir, localDir,
    args: fixed, input: bytes, inputHash: createHash("sha256").update(bytes).digest("hex"), consumed: false });
  return grant;
}

export function validateConfiguredHostStartState(ctx: Ctx, grant: ConfiguredHostStartGrant): void {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = snapshot(ctx, saved.alias, saved.remoteDir, saved.localDir, saved.args);
  if (current.taskId !== saved.taskId || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task.run) !== saved.runFingerprint || JSON.stringify(current.host) !== saved.hostFingerprint ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "START" || grant.resource.timeoutMs !== 60_000 || grant.resource.maxBytes !== 65_536 ||
    grant.resource.args.length !== saved.args.length || grant.resource.args.some((value, index) => value !== saved.args[index])) return deny();
}

export function validateConfiguredHostStart(ctx: Ctx, grant: ConfiguredHostStartGrant): void {
  validateConfiguredHostStartState(ctx, grant);
  const saved = issued.get(grant)!;
  if (saved.input.length < 1 || saved.input.length > MAX_START_INPUT ||
    createHash("sha256").update(saved.input).digest("hex") !== saved.inputHash) return deny();
}

export function consumeConfiguredHostStart(ctx: Ctx, grant: ConfiguredHostStartGrant): Uint8Array {
  validateConfiguredHostStart(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
  return Uint8Array.from(saved.input);
}
