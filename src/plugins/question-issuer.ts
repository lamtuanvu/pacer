import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface PersistedQuestionGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured { home: string; taskId: string; attempt: number; rev: number; alias: string;
  path: string; fingerprint: string; consumed: boolean }
const issued = new WeakMap<PersistedQuestionGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "remote question grant is stale or was not issued"); };

/** Git's blob hash permits a remote content check without embedding question text in SSH argv. */
export function questionBlobHash(text: string, algorithm: "sha1" | "sha256" = "sha1"): string {
  const bytes = Buffer.from(text);
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function issuePersistedQuestion(ctx: Ctx, taskId: string, attempt: number): PersistedQuestionGrant {
  const task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || run.attempt !== attempt || !run.remoteWorktree || !isAbsolute(run.remoteWorktree) ||
    run.remoteWorktree.length > 4096 || /[\u0000-\u001f\u007f]/.test(run.remoteWorktree) || !run.host) return deny();
  const host = loadStrategy(ctx).hosts[run.host];
  if (!host || host.paused) return deny();
  const args = Object.freeze([run.remoteWorktree]);
  const resource: HostOperationResource = Object.freeze({ alias: run.host,
    hostFingerprint: JSON.stringify(host), script: "QUESTION",
    args: [...args], timeoutMs: 20_000, maxBytes: 8192 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, taskId, attempt, rev: task.rev, alias: run.host,
    path: run.remoteWorktree, fingerprint: JSON.stringify(host), consumed: false });
  return grant;
}

export function validatePersistedQuestion(ctx: Ctx, grant: PersistedQuestionGrant): void {
  const saved = issued.get(grant), resource = grant.resource;
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const task = readTask(ctx, saved.taskId), run = task?.run;
  const host = loadStrategy(ctx).hosts[saved.alias];
  if (!task || task.rev !== saved.rev || !run || run.attempt !== saved.attempt ||
    run.host !== saved.alias || run.remoteWorktree !== saved.path || !host || host.paused ||
    JSON.stringify(host) !== saved.fingerprint || resource.alias !== saved.alias ||
    resource.hostFingerprint !== saved.fingerprint || resource.script !== "QUESTION" ||
    resource.timeoutMs !== 20_000 || resource.maxBytes !== 8192 ||
    JSON.stringify(resource.args) !== JSON.stringify([saved.path])) return deny();
}

export function consumePersistedQuestion(ctx: Ctx, grant: PersistedQuestionGrant): void {
  validatePersistedQuestion(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
