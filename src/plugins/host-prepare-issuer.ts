import { hostFingerprint as driftFingerprint, matchesHostFingerprint } from "./host-drift";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { repoKey } from "../config/hosts";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { gitInfo } from "../core/git";
import { CoreError } from "../core/errors";
import { resolveWorktreeBase } from "../supervisor/worktree";
import { readTask } from "../tasks/store";
import type { Ctx } from "../types";
import type { HostOperationResource } from "./authority";

const MAX_BUNDLE = 50 * 1024 * 1024;
const deny = (): never => { throw new CoreError("capability_denied", "configured remote prepare changed or was not issued"); };

export interface ConfiguredHostPrepareGrant { readonly resource: Readonly<HostOperationResource> }
interface Captured {
  home: string;
  repo: string;
  taskId: string;
  taskRev: number;
  taskFingerprint: string;
  hostFingerprint: string;
  origin: string;
  args: readonly string[];
  bundle: Uint8Array;
  digest: string;
  consumed: boolean;
}
const issued = new WeakMap<ConfiguredHostPrepareGrant, Captured>();

async function snapshot(ctx: Ctx, alias: string, taskId: string, baseSha: string, branch: string) {
  const task = readTask(ctx, taskId);
  if (!task || !isAbsolute(task.brief.repo) || !/^[a-f0-9]{40,64}$/.test(baseSha) ||
    !branch || branch.length > 256 || /[\u0000-\u001f\u007f]/.test(branch)) return deny();
  const host = loadStrategy(ctx).hosts[alias];
  if (!host || host.paused) return deny();
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return deny();
  const execution = validateExecution(loadStrategy(ctx).execution);
  const resolved = await resolveWorktreeBase(ctx, git.top, task.brief, execution.baseBranch);
  if ("error" in resolved || resolved.sha !== baseSha || resolved.base !== branch) return deny();
  const origin = await ctx.run(["git", "-C", task.brief.repo, "remote", "get-url", "origin"], 10_000);
  if (origin.code || origin.timedOut) return deny();
  const url = origin.stdout.trim(), key = repoKey(url);
  if (!key || !url || url.length > 4096 || /[\u0000-\u001f\u007f]/.test(url)) return deny();
  const path = host.repos[key];
  if (!path || !(isAbsolute(path) || path.startsWith("~/")) ||
    path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) return deny();
  const commit = await ctx.run(["git", "-C", task.brief.repo, "rev-parse", "--verify", `${baseSha}^{commit}`], 10_000);
  if (commit.code || commit.timedOut || commit.stdout.trim() !== baseSha) return deny();
  const tag = `${key.split("/").at(-1)}-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`;
  const args = [path, tag, taskId, baseSha, branch, String(task.attempts.length + 1)];
  if (args.some(value => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value))) return deny();
  return { task, host, url, args };
}

/** Mint an exact PREPARE invocation from the current persisted task and configured checkout. */
export async function issueConfiguredHostPrepare(ctx: Ctx, alias: string, taskId: string,
  baseSha: string, branch: string, bundle: Uint8Array): Promise<ConfiguredHostPrepareGrant> {
  if (!(bundle instanceof Uint8Array) || bundle.length > MAX_BUNDLE) return deny();
  const current = await snapshot(ctx, alias, taskId, baseSha, branch);
  const args = Object.freeze(current.args);
  const hostFingerprint = driftFingerprint(current.host, current.args, true);
  const resource: HostOperationResource = Object.freeze({ alias, hostFingerprint,
    script: "PREPARE", args: [...args], timeoutMs: 60_000, maxBytes: 65_536 });
  Object.freeze(resource.args);
  const grant = Object.freeze({ resource });
  const bytes = Uint8Array.from(bundle);
  issued.set(grant, { home: ctx.pacerHome, repo: current.task.brief.repo, taskId,
    taskRev: current.task.rev, taskFingerprint: JSON.stringify(current.task), hostFingerprint,
    origin: current.url, args, bundle: bytes, digest: createHash("sha256").update(bytes).digest("hex"), consumed: false });
  return grant;
}

export async function validateConfiguredHostPrepare(ctx: Ctx, grant: ConfiguredHostPrepareGrant): Promise<void> {
  const saved = issued.get(grant);
  if (!saved || saved.home !== ctx.pacerHome) return deny();
  const current = await snapshot(ctx, grant.resource.alias, saved.taskId, saved.args[3]!, saved.args[4]!);
  if (current.task.brief.repo !== saved.repo || current.task.rev !== saved.taskRev ||
    JSON.stringify(current.task) !== saved.taskFingerprint || matchesHostFingerprint(current.host, saved.hostFingerprint) === false ||
    current.url !== saved.origin || current.args.length !== saved.args.length ||
    current.args.some((value, index) => value !== saved.args[index]) ||
    grant.resource.hostFingerprint !== saved.hostFingerprint || grant.resource.script !== "PREPARE" ||
    grant.resource.timeoutMs !== 60_000 || grant.resource.maxBytes !== 65_536 ||
    grant.resource.args.length !== saved.args.length ||
    grant.resource.args.some((value, index) => value !== saved.args[index]) ||
    saved.bundle.length > MAX_BUNDLE || createHash("sha256").update(saved.bundle).digest("hex") !== saved.digest) return deny();
}

/** Consumes the grant before provider effects; returns a separate host-owned byte copy. */
export async function consumeConfiguredHostPrepare(ctx: Ctx, grant: ConfiguredHostPrepareGrant): Promise<Uint8Array> {
  await validateConfiguredHostPrepare(ctx, grant);
  const saved = issued.get(grant);
  if (!saved || saved.consumed) return deny();
  saved.consumed = true;
  return Uint8Array.from(saved.bundle);
}
