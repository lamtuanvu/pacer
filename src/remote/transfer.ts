import { existsSync } from "node:fs";
import type { HostCfg } from "../config/hosts";
import { taskWorktreePath } from "../supervisor/worktree";
import { ask } from "../core/tasks";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { RunRef, TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { pluginRegistry } from "../plugins";
import { issuePersistedFetch, validatePersistedFetch, type PersistedFetchGrant } from "../plugins/fetch-issuer";
import { issuePersistedQuestion } from "../plugins/question-issuer";
import { prepareClaimedBundle, publishPreparedBundle, removeConsumedClaimedBundle,
  withFinalizedClaimedBundleInput } from "../plugins/claimed-bundle";
import type { CallAuthority } from "../plugins/authority";
import type { ClaimedBundleTicket } from "../plugins/bundle-stage";
import { execProcess } from "../exec/process";

type TransferResult = { ok: true; branch: string; commits: number; reviewWorktree: string } | { ok: false; reason: string; bundle?: string };

/** Collect the file before cleanliness checks, including failed/no-commit attempts. */
export async function receiveQuestion(ctx: Ctx, task: TaskRecord, host: HostCfg, run: RunRef): Promise<void> {
  if (!run.remoteWorktree) return;
  if (run.host !== host.alias) throw new Error("remote question host changed");
  const registry = pluginRegistry(ctx), caller = registry.find(ctx, "remoteCaller", () => true);
  if (caller !== "pacer-remote-caller") throw new Error("bundled remote caller plugin is unavailable");
  const read = issuePersistedQuestion(ctx, task.id, run.attempt);
  const result = await registry.callWithIssuedHostQuestion<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
    ctx, caller, "remoteCaller.questionRead", { alias: host.alias, path: run.remoteWorktree }, read);
  if (result.code || result.timedOut) throw new Error(result.stderr || "cannot read remote question");
  if (!result.stdout) return;
  const prior = readTask(ctx,task.id)?.question;
  if (prior && prior.text !== result.stdout) throw new Error("remote question changed after task acceptance");
  if (!prior) await ask(ctx,task.id,result.stdout);
}

/** Receive only committed task changes, after checking ancestry, cleanliness and identity. */
export async function transferBack(ctx: Ctx, task: TaskRecord, host: HostCfg, run: RunRef, bundleTimeoutMs = 60_000): Promise<TransferResult> {
  let branch = `pacer/${task.id}`, ref = `refs/heads/${branch}`;
  const remoteBranch = run.remoteBranch ?? branch;
  // The broker may roll back a publication after our claim callback. A path
  // observed there is never stable failure evidence for this caller.
  const fail = (reason: string): TransferResult => ({ ok: false, reason });
  const git = (...args: string[]) => ctx.run(["git", "-C", task.brief.repo, ...args], 60000);
  const owned = readTask(ctx, task.id)?.executorProvider === "pacer-exec-direct";
  const matchesPersisted = (grant?: PersistedFetchGrant): boolean => {
    const current = readTask(ctx, task.id), saved = current?.run;
    return !!current && !!saved &&
      (!owned || (current.state === "running" && !current.stopPending &&
        current.executorProvider === "pacer-exec-direct" &&
        current.startIntent?.attempt === run.attempt &&
        current.startIntent.providerId === current.executorProvider &&
        current.startIntent.dir === run.dir &&
        current.executorExitReceipt?.attempt === run.attempt &&
        current.executorExitReceipt.providerId === current.executorProvider &&
        current.executorExitReceipt.dir === run.dir &&
        current.executorExitReceipt.startedAt === run.startedAt)) &&
      current.brief.repo === task.brief.repo &&
      saved.attempt === run.attempt && saved.host === run.host &&
      saved.remoteWorktree === run.remoteWorktree && saved.baseSha === run.baseSha &&
      saved.remoteBranch === run.remoteBranch &&
      (!grant || (current.rev === grant.taskRev && current.brief.repo === grant.repo &&
        saved.remoteWorktree === grant.resource.args[0] &&
        saved.baseSha === grant.resource.args[1] && saved.remoteBranch === grant.resource.args[2]));
  };
  try {
    if (!matchesPersisted()) return fail("remote transfer task or run changed");
    await receiveQuestion(ctx,task,host,run);
    if (!matchesPersisted()) return fail("remote transfer task or run changed");
    const priorIntent = owned ? readTask(ctx, task.id)?.remoteTransferIntent : undefined;
    if (priorIntent && (priorIntent.attempt !== run.attempt ||
      priorIntent.providerId !== "pacer-exec-direct" || priorIntent.dir !== run.dir ||
      priorIntent.startedAt !== run.startedAt ||
      ![`pacer/${task.id}`, `pacer/${task.id}-r${run.attempt}`].includes(priorIntent.branch) ||
      priorIntent.oldHead !== "" && !/^[a-f0-9]{40,64}$/.test(priorIntent.oldHead)))
      return fail("remote transfer destination changed");
    if (priorIntent) { branch = priorIntent.branch; ref = `refs/heads/${branch}`; }
    const exists = await git("show-ref", "--verify", "--quiet", ref);
    if (exists.code !== 0 && exists.code !== 1) return fail(exists.stderr.trim() || "local branch check failed");
    if (!run.remoteWorktree || !run.baseSha) return fail("remote run has no worktree or base");
    let current = "";
    if (exists.code === 0) {
      const head = await git("rev-parse", "--verify", ref);
      if (head.code) return fail("local branch check failed");
      current = head.stdout.trim();
      const ahead = await git("rev-list", "--count", `${run.baseSha}..${current}`);
      if (ahead.code) return fail("local branch ancestry check failed");
      if (!priorIntent && ahead.stdout.trim() !== "0") {
        branch += `-r${run.attempt}`;
        ref = `refs/heads/${branch}`;
        current = "";
      }
    }
    if (owned && !priorIntent) {
      withTaskLock(ctx, task.id, () => {
        if (!matchesPersisted() || readTask(ctx, task.id)?.remoteTransferIntent)
          throw new Error("remote transfer owner changed before destination admission");
        updateTask(ctx, task.id, record => { record.remoteTransferIntent = {
          attempt: run.attempt, providerId: "pacer-exec-direct", dir: run.dir,
          startedAt: run.startedAt, branch, oldHead: current }; });
      });
    }
    if (run.remoteBranch !== remoteBranch || run.host !== host.alias)
      return fail("remote run does not match the configured host and branch");
    const grant = issuePersistedFetch(ctx, task.id, run.attempt, 50 * 1024 * 1024, bundleTimeoutMs);
    if (!matchesPersisted(grant)) return fail("remote transfer task or run changed");
    const registry = pluginRegistry(ctx), caller = registry.find(ctx, "remoteCaller", () => true);
    if (caller !== "pacer-remote-caller") return fail("bundled remote caller plugin is unavailable");
    let claimed: { authority: CallAuthority; ticket: ClaimedBundleTicket } | undefined;
    let verified: { head: string; commits: number } | undefined;
    await registry.callWithIssuedHostFetch<{ ok: true }>(ctx, caller, "remoteCaller.fetch",
      { alias: host.alias, timeoutMs: bundleTimeoutMs, maxBytes: 50 * 1024 * 1024 }, grant,
      async (authority, ticket) => {
        const prepared = await prepareClaimedBundle(authority, ticket, grant);
        publishPreparedBundle(authority, prepared);
        claimed = { authority, ticket }; verified = prepared;
      });
    if (!claimed || !verified) return fail("remote bundle was not finalized");
    const { authority, ticket } = claimed;
    const { head, commits } = verified;
    if (priorIntent && current !== priorIntent.oldHead && current !== head)
      return fail("remote transfer destination differs from the verified bundle");
    // Git cannot fetch from /dev/fd/0 on macOS. Unbundle the immutable host
    // snapshot into the object database, then compare-and-swap only our ref.
    const imported = await withFinalizedClaimedBundleInput(authority, ticket, grant, async input => {
      const executable = ctx.which("git");
      if (!executable?.startsWith("/")) throw new Error("local git is unavailable");
      return execProcess({ argv: [executable, "-C", task.brief.repo, "bundle", "unbundle", "/dev/fd/0"],
        cwd: ctx.home, env: ctx.env, stdinBlob: input, timeoutMs: 60_000, maxStdoutBytes: 1024 * 1024 });
    });
    if (imported.code || imported.timedOut || imported.stdoutOverflow ||
      imported.stdout.trim() !== `${head} refs/heads/${remoteBranch}`)
      return fail(imported.stderr.trim() || "bundle unbundle failed");
    // A question written during preflight or bundle import must not be missed
    // before the local branch is published.
    await receiveQuestion(ctx,task,host,run);
    validatePersistedFetch(ctx, grant);
    if (!matchesPersisted(grant)) return fail("remote transfer task or run changed");
    // Cleanup can fail under same-UID replacement. Settle it before publishing
    // the branch so a failure result never hides a committed local transfer.
    removeConsumedClaimedBundle(authority, ticket, grant);
    const top = await git("rev-parse", "--show-toplevel");
    if (top.code) return fail(top.stderr.trim() || "local repo root unavailable");
    const reviewWorktree = taskWorktreePath(ctx, top.stdout.trim(), task.id);
    const reuse = existsSync(reviewWorktree);
    let switchBranch = false;
    if (reuse) {
      const checkedOut = await ctx.run(["git", "-C", reviewWorktree, "symbolic-ref", "HEAD"], 10000);
      const status = await ctx.run(["git", "-C", reviewWorktree, "status", "--porcelain"], 10000);
      if (checkedOut.code || ![ref, `refs/heads/pacer/${task.id}`].includes(checkedOut.stdout.trim()) || status.code || status.stdout.trim()) return fail("review worktree is occupied or dirty");
      switchBranch = checkedOut.stdout.trim() !== ref;
    }
    validatePersistedFetch(ctx, grant);
    if (!matchesPersisted(grant)) return fail("remote transfer task or run changed");
    const created = await git("update-ref", ref, head, current || "0".repeat(head.length));
    if (created.code) return fail(`local branch ${branch} exists; not overwritten`);
    let added;
    if (reuse) {
      added = switchBranch
        ? await ctx.run(["git", "-C", reviewWorktree, "checkout", "-q", branch], 60000)
        : await ctx.run(["git", "-C", reviewWorktree, "read-tree", "--reset", "-u", head], 60000);
    } else added = await git("worktree", "add", "-q", reviewWorktree, branch);
    if (added.code) return fail(added.stderr.trim() || "review worktree creation failed");
    run.transferredHead = head;
    updateTask(ctx, task.id, t => {
      if (t.run?.attempt === run.attempt) t.run.transferredHead = head;
    });
    return { ok: true, branch, commits, reviewWorktree };
  } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
}

/** A branch name alone is not evidence that this remote result was received. */
export async function transferred(ctx: Ctx, task: TaskRecord): Promise<boolean> {
  if (!task.run?.transferredHead) return false;
  const owned = task.executorProvider === "pacer-exec-direct";
  const intent = task.remoteTransferIntent;
  if (owned && (!intent || intent.attempt !== task.run.attempt ||
    intent.providerId !== task.executorProvider || intent.dir !== task.run.dir ||
    intent.startedAt !== task.run.startedAt ||
    ![`pacer/${task.id}`, `pacer/${task.id}-r${task.run.attempt}`].includes(intent.branch))) return false;
  const branch = owned ? intent!.branch : `pacer/${task.id}`;
  const ref = await ctx.run(["git", "-C", task.brief.repo, "rev-parse", "--verify", `refs/heads/${branch}`], 10000);
  return ref.code === 0 && ref.stdout.trim() === task.run.transferredHead;
}
