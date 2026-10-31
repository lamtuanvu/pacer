import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { basename, dirname, isAbsolute, join } from "node:path";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { CoreError } from "../core/errors";
import { readTask } from "../tasks/store";
import { TERMINAL_STATES } from "../tasks/types";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

export interface ConfiguredHostCleanGrant { readonly resource: Readonly<HostOperationResource> }

interface Captured {
  home: string;
  alias: string;
  taskId: string;
  taskRev: number;
  runFingerprint: string;
  hostFingerprint: string;
  repo: string;
  origin: string;
  args: readonly string[];
  received: boolean;
  force: boolean;
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostCleanGrant, Captured>();
const deny = (): never => { throw new CoreError("capability_denied", "configured host cleanup changed or was not issued"); };

async function snapshot(ctx: Ctx, alias: string, taskId: string, force: boolean) {
  const task = readTask(ctx, taskId), run = task?.run;
  if (!task || !run || !TERMINAL_STATES.includes(task.state) ||
    !(task.review || task.dismissed || task.resolved) || run.host !== alias || run.mode !== "new" ||
    !isAbsolute(task.brief.repo) || !run.remoteWorktree || !run.remoteDir ||
    !Number.isSafeInteger(run.attempt) || run.attempt < 1) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host) return deny();
  const result = await ctx.run(["git", "-C", task.brief.repo, "remote", "get-url", "origin"], 10_000);
  if (result.code !== 0 || result.timedOut) return deny();
  const origin = result.stdout.trim(), key = repoKey(origin);
  const checkout = key && Object.hasOwn(host.repos, key) ? host.repos[key] : undefined;
  if (!checkout || !(isAbsolute(checkout) || checkout.startsWith("~/")) ||
    checkout.length > 4096 || /[\u0000-\u001f\u007f]/.test(checkout)) return deny();
  const marker = "/.pacer-remote/runs/", at = run.remoteDir.indexOf(marker);
  if (at < 1 || run.remoteDir !== `${run.remoteDir.slice(0, at)}${marker}${taskId}/${run.attempt}` ||
    !isAbsolute(run.remoteWorktree) ||
    dirname(dirname(run.remoteWorktree)) !== join(run.remoteDir.slice(0, at), ".pacer-remote", "worktrees") ||
    basename(run.remoteWorktree) !== `${taskId}-${run.attempt}` ||
    [run.remoteWorktree, run.remoteDir, origin].some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) return deny();
  const { transferred } = await import("../remote/transfer");
  const received = await transferred(ctx, task).catch(() => false);
  const branch = run.remoteBranch ?? `pacer/${taskId}`;
  if (received && branch !== `pacer/${taskId}` && branch !== `pacer/${taskId}-${run.attempt}`) return deny();
  // `force` is CLEAN's sixth argument: it removes a dirty remote worktree, as `pacer clean --force` does locally.
  return { task, host, origin, received, args: [run.remoteWorktree, run.remoteDir, checkout, taskId, received ? branch : "", ...(force ? ["force"] : [])] };
}

/** Mint only for an eligible persisted task and its exact configured cleanup tuple. */
export async function issueConfiguredHostClean(ctx: Ctx, alias: string, taskId: string,
  expectedReceived: boolean, o: { force?: boolean } = {}): Promise<ConfiguredHostCleanGrant> {
  const force = o.force === true;
  const current = await snapshot(ctx, alias, taskId, force);
  if (current.received !== expectedReceived) return deny();
  const hostFingerprint = driftFingerprint(current.host, [current.args[2]!]), args = Object.freeze(current.args);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "CLEAN", args: [...args], timeoutMs: 50_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  issued.set(grant, { home: ctx.pacerHome, alias, taskId, taskRev: current.task.rev,
    runFingerprint: JSON.stringify(current.task.run), hostFingerprint, repo: current.task.brief.repo,
    origin: current.origin, args, received: current.received, force, consumed: false });
  return grant;
}

export async function validateConfiguredHostClean(ctx: Ctx, grant: ConfiguredHostCleanGrant): Promise<void> {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = await snapshot(ctx, saved.alias, saved.taskId, saved.force);
  if (current.task.rev !== saved.taskRev || JSON.stringify(current.task.run) !== saved.runFingerprint ||
    current.task.brief.repo !== saved.repo || current.origin !== saved.origin ||
    matchesHostFingerprint(current.host, saved.hostFingerprint) === false || current.received !== saved.received ||
    current.args.length !== saved.args.length || current.args.some((arg, index) => arg !== saved.args[index]) ||
    grant.resource.alias !== saved.alias || grant.resource.hostFingerprint !== saved.hostFingerprint ||
    grant.resource.script !== "CLEAN" || grant.resource.timeoutMs !== 50_000 ||
    grant.resource.maxBytes !== 65_536 || grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((arg, index) => arg !== saved.args[index])) return deny();
}

export async function consumeConfiguredHostClean(ctx: Ctx, grant: ConfiguredHostCleanGrant): Promise<void> {
  await validateConfiguredHostClean(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
}
