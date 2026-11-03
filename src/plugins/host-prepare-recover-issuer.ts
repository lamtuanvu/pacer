import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { gitInfo } from "../core/git";
import { readTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "unreceipted remote prepare intent changed"); };

export interface ConfiguredHostPrepareRecoverGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured { home: string; taskId: string; intent: NonNullable<TaskRecord["remotePrepareIntent"]>;
  consumed: boolean }
const issued = new WeakMap<ConfiguredHostPrepareRecoverGrant, Captured>();

async function snapshot(ctx: Ctx, taskId: string) {
  const task = readTask(ctx, taskId), intent = task?.remotePrepareIntent;
  if (!task || !intent || task.state !== "running" || task.stopPending || task.run ||
    task.executorProvider !== "pacer-exec-direct" || intent.providerId !== task.executorProvider ||
    task.executor !== intent.executor || intent.attempt !== task.attempts.length + 1 ||
    !/^[a-f0-9]{40,64}$/.test(intent.baseSha) || !intent.base) return deny();
  const host = loadStrategy(ctx).hosts[intent.alias];
  if (!host || host.paused || JSON.stringify(host) !== intent.hostFingerprint) return deny();
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git || realpathSync(git.top) !== intent.repoTop) return deny();
  const origin = await ctx.run(["git", "-C", git.top, "remote", "get-url", "origin"], 10_000);
  if (origin.code || origin.timedOut ||
    createHash("sha256").update(origin.stdout.trim()).digest("hex") !== intent.originHash) return deny();
  const key = repoKey(origin.stdout.trim());
  if (!key || host.repos[key] !== intent.checkout ||
    intent.tag !== `${key.split("/").at(-1)}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`)
    return deny();
  const base = await ctx.run(["git", "-C", git.top, "rev-parse", "--verify", `${intent.base}^{commit}`], 10_000);
  if (base.code || base.timedOut || base.stdout.trim() !== intent.baseSha) return deny();
  return { intent, host };
}

/** Only a persisted, unreceipted PREPARE can issue this read-only SSH proof. */
export async function issueConfiguredHostPrepareRecover(ctx: Ctx, taskId: string): Promise<ConfiguredHostPrepareRecoverGrant> {
  const { intent } = await snapshot(ctx, taskId);
  const args = [intent.checkout, intent.tag, taskId, intent.baseSha,
    intent.base, String(intent.attempt)];
  const resource: HostOperationResource = Object.freeze({ alias: intent.alias,
    hostFingerprint: intent.hostFingerprint, script: "PREPARE_RECOVER", args,
    timeoutMs: 30_000, maxBytes: 65_536 });
  Object.freeze(args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, taskId, intent: { ...intent }, consumed: false });
  return grant;
}

export async function validateConfiguredHostPrepareRecover(ctx: Ctx,
  grant: ConfiguredHostPrepareRecoverGrant): Promise<void> {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = await snapshot(ctx, saved.taskId);
  const intent = current.intent;
  if (JSON.stringify(intent) !== JSON.stringify(saved.intent) ||
    grant.resource.alias !== intent.alias || grant.resource.hostFingerprint !== intent.hostFingerprint ||
    grant.resource.script !== "PREPARE_RECOVER" || grant.resource.timeoutMs !== 30_000 ||
    grant.resource.maxBytes !== 65_536 ||
    JSON.stringify(grant.resource.args) !== JSON.stringify([intent.checkout, intent.tag, saved.taskId,
      intent.baseSha, intent.base, String(intent.attempt)])) return deny();
}

export async function consumeConfiguredHostPrepareRecover(ctx: Ctx,
  grant: ConfiguredHostPrepareRecoverGrant): Promise<void> {
  await validateConfiguredHostPrepareRecover(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
