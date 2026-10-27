import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { gitInfo } from "../core/git";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

type Intent = NonNullable<TaskRecord["remotePrepareIntent"]>;
const deny = (): never => { throw new CoreError("capability_denied", "remote placement owner or source changed"); };
export interface OwnedRemotePrepareGrant { readonly nonce: string; readonly taskId: string; readonly attempt: number;
  readonly providerId: string; readonly mode: "prepare" | "recover" }
const issued = new Map<string, { home: string; intent: Intent;
  mode: "prepare" | "recover"; expiresAt: number }>();

/** Persist an exact first PREPARE before any remote effect. A later admission is recover-only. */
export async function admitOwnedRemotePrepare(ctx: Ctx, taskId: string, providerId: string,
  executor: string, alias: string, base: string, baseSha: string): Promise<{ mode: "prepare" | "recover"; intent: Intent;
    grant: OwnedRemotePrepareGrant }> {
  if (providerId !== "pacer-exec-direct" || !/^[a-f0-9]{40,64}$/.test(baseSha) ||
    !base || base.length > 256 || /[\u0000-\u001f\u007f]/.test(base)) return deny();
  const task = readTask(ctx, taskId);
  if (!task || task.state !== "running" || task.stopPending || task.run ||
    task.executorProvider !== providerId || task.executor !== executor ||
    executor !== `${executor.split("@")[0]}@${alias}`) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused) return deny();
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return deny();
  const origin = await ctx.run(["git", "-C", git.top, "remote", "get-url", "origin"], 10_000);
  if (origin.code || origin.timedOut) return deny();
  const url = origin.stdout.trim(), key = repoKey(url);
  if (!url || url.length > 4096 || /[\u0000-\u001f\u007f]/.test(url) || !key) return deny();
  const checkout = host.repos[key];
  if (!checkout || checkout.length > 4096 || /[\u0000-\u001f\u007f]/.test(checkout)) return deny();
  const resolved = await ctx.run(["git", "-C", git.top, "rev-parse", "--verify", `${base}^{commit}`], 10_000);
  if (resolved.code || resolved.timedOut || resolved.stdout.trim() !== baseSha) return deny();
  const intent: Intent = { attempt: task.attempts.length + 1, providerId, executor, alias,
    hostFingerprint: JSON.stringify(host), repoTop: realpathSync(git.top),
    originHash: createHash("sha256").update(url).digest("hex"), checkout,
    tag: `${key.split("/").at(-1)}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`,
    baseSha, base };
  const admitted = withTaskLock(ctx, taskId, () => {
    const current = readTask(ctx, taskId);
    if (!current || current.state !== "running" || current.stopPending || current.run ||
      current.executorProvider !== providerId || current.executor !== executor ||
      current.attempts.length + 1 !== intent.attempt || current.brief.repo !== task.brief.repo ||
      JSON.stringify(loadStrategy(ctx).hosts[alias]) !== intent.hostFingerprint) return deny();
    const prior = current.remotePrepareIntent;
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(intent)) return deny();
      return { mode: "recover" as const, intent: prior };
    }
    if (current.rev !== task.rev) return deny();
    updateTask(ctx, taskId, record => { record.remotePrepareIntent = intent; });
    return { mode: "prepare" as const, intent };
  });
  for (const [nonce, saved] of issued) if (saved.expiresAt <= Date.now()) issued.delete(nonce);
  const grant: OwnedRemotePrepareGrant = Object.freeze({ nonce: randomUUID(), taskId,
    attempt: admitted.intent.attempt,
    providerId, mode: admitted.mode });
  issued.set(grant.nonce, { home: ctx.pacerHome, intent: { ...admitted.intent },
    mode: admitted.mode, expiresAt: Date.now() + 120_000 });
  return { ...admitted, grant };
}

/** Consume before any provider effect; a replay cannot turn recovery into another PREPARE. */
export function consumeOwnedRemotePrepareGrant(ctx: Ctx, grant: OwnedRemotePrepareGrant): Intent {
  const saved = issued.get(grant.nonce), task = readTask(ctx, grant.taskId);
  if (!saved || saved.expiresAt <= Date.now() || saved.home !== ctx.pacerHome ||
    task?.state !== "running" || task.stopPending || task.run ||
    task.executorProvider !== grant.providerId || task.executor !== saved.intent.executor ||
    task.attempts.length + 1 !== grant.attempt ||
    JSON.stringify(task.remotePrepareIntent) !== JSON.stringify(saved.intent) ||
    grant.mode !== saved.mode) return deny();
  issued.delete(grant.nonce);
  return { ...saved.intent };
}
