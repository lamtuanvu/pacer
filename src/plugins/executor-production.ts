import { lstatSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { loadStrategy, type ProviderCfg } from "../config/strategy";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { validateExecution } from "../config/execution";
import { launchFor, providerEnv } from "../exec/launch";
import { executorEnv } from "../exec/process";
import { buildPrompt } from "../exec/prompt";
import { resolveWorktreeBase, taskWorktreePath } from "../supervisor/worktree";
import type { AttemptOutcome } from "../exec/direct";
import { listTasksWhere, readTask, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { pluginRegistry } from "./index";
import { executorAttemptOutcome } from "./executor-protocol";
import { inspectOwnedExecutorRun } from "./executor-run-state";
import { issueOwnedWorktreeGrant } from "./executor-worktree";
import { admitOwnedRemotePrepare } from "./executor-remote-prepare";
import type { CallResources } from "./authority";

interface ExecutorCaller {
  call(ctx: Ctx, pluginId: string, method: "executor.run", params: unknown,
    options: { resources: CallResources; onProgress: (event: unknown) => void; deadlineMs: number }): Promise<unknown>;
}

async function admittedDefaultBase(ctx: Ctx, task: TaskRecord, providerId: string,
  attempt: number): Promise<string> {
  const info = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in info) throw new CoreError("capability_denied", "origin fetch needs a verified repository");
  const remote = await ctx.run(["git", "-C", info.top, "remote", "get-url", "origin"], 10_000);
  const origin = remote.stdout.trim();
  if (remote.code !== 0 && !remote.timedOut) {
    const listed = await ctx.run(["git", "-C", info.top, "remote"], 10_000);
    if (listed.code === 0 && !listed.timedOut &&
      !listed.stdout.trim().split(/\s+/).includes("origin")) return "HEAD";
  }
  if (remote.code !== 0 || remote.timedOut || !origin || origin.length > 4096 || /[\0\r\n]/.test(origin))
    throw new CoreError("capability_denied", "origin fetch needs one configured remote");
  const originHash = createHash("sha256").update(origin).digest("hex");
  const recorded = withTaskLock(ctx, task.id, () => {
    const current = readTask(ctx, task.id), prior = current?.baseFetchIntent;
    if (!current || current.state !== "running" || current.stopPending || current.run ||
      current.executorProvider !== providerId || current.attempts.length + 1 !== attempt ||
      current.brief.repo !== task.brief.repo || realpathSafe(info.top) !== realpathSafe(prior?.repoTop ?? info.top))
      throw new CoreError("capability_denied", "origin fetch owner changed");
    if (prior) {
      if (prior.attempt !== attempt || prior.providerId !== providerId ||
        prior.repoTop !== info.top || prior.originHash !== originHash || !prior.sha)
        throw new CoreError("conflict", "origin fetch outcome is uncertain; retry refused");
      return prior;
    }
    const intent: NonNullable<TaskRecord["baseFetchIntent"]> = { attempt, providerId, repoTop: info.top, originHash };
    updateTask(ctx, task.id, current => { current.baseFetchIntent = intent; });
    return intent;
  });
  if (recorded.sha) return recorded.sha;
  const resolved = await resolveWorktreeBase(ctx, info.top, task.brief, null, false);
  if ("error" in resolved) throw new CoreError("conflict", resolved.error);
  withTaskLock(ctx, task.id, () => {
    const current = readTask(ctx, task.id), intent = current?.baseFetchIntent;
    if (!current || current.state !== "running" || current.stopPending || current.run ||
      current.executorProvider !== providerId || intent?.attempt !== attempt ||
      intent.providerId !== providerId || intent.repoTop !== info.top ||
      intent.originHash !== originHash || intent.sha)
      throw new CoreError("conflict", "origin fetch owner changed after effect");
    updateTask(ctx, task.id, current => { current.baseFetchIntent = { ...intent,
      base: resolved.base, sha: resolved.sha }; });
  });
  return resolved.sha;
}

/** A selected local noninteractive attempt, with placement owned by the same plugin call. */
async function runOwnedDirect(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  placement: "current" | "new", caller: ExecutorCaller): Promise<AttemptOutcome> {
  const providerId = "pacer-exec-direct", current = readTask(ctx, task.id);
  if (!current || current.state !== "running" || current.stopPending || current.run ||
    current.executorProvider !== providerId || current.executor !== cfg.id ||
    current.attempts.length !== task.attempts.length ||
    current.brief.repo !== task.brief.repo || task.interactionMode === "conversation" ||
    cfg.session === "interactive" || parseRunnerId(cfg.id)?.host ||
    current.worktreeIntent && (placement !== "new" ||
      current.worktreeIntent.providerId !== providerId ||
      current.worktreeIntent.attempt !== current.attempts.length + 1) ||
    current.worktree && (placement !== "new" || !current.retryOf) ||
    !Number.isSafeInteger(task.timeoutS) || task.timeoutS < 1 || task.timeoutS > 1800)
    throw new CoreError("capability_denied", "direct executor route is not an owned local attempt");
  const strategy = loadStrategy(ctx), execution = validateExecution(strategy.execution);
  const attempt = current.attempts.length + 1, dir = join(ctx.pacerHome, "runs", task.id, String(attempt));
  let worktreeGrant: Awaited<ReturnType<typeof issueOwnedWorktreeGrant>> | undefined;
  let workdir: string;
  if (placement === "current") {
    if (current.placement?.requested === "new" || current.placement?.mode === "new" ||
      current.placement?.requested !== "current" && execution.worktree !== "current" &&
        current.placement?.mode !== "current")
      throw new CoreError("capability_denied", "local current placement is not selected");
    const source = realpathSafe(task.brief.repo);
    const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
    if (current.placement?.why === "strategy default" && !("error" in git) && git.dirty)
      throw new CoreError("capability_denied", "current checkout has uncommitted changes");
    const occupied = listTasksWhere(ctx, { states: ["queued", "running"] }).some(other =>
      other.id !== task.id && realpathSafe(other.worktree ?? other.result?.worktree ?? other.brief.repo) === source &&
      (other.interactionMode === "conversation" && other.placement?.requested === "current" ||
        other.state === "running" && other.placement?.mode === "current" && !!other.runnerPid &&
          (() => { try { process.kill(other.runnerPid!, 0); return true; } catch { return false; } })()));
    if (occupied) throw new CoreError("capability_denied", "current checkout is owned by another task");
    workdir = realpathSync(task.brief.repo);
  } else {
    if (current.placement?.requested === "current" || current.placement?.mode === "current" ||
      current.placement?.requested !== "new" && execution.worktree === "current")
      throw new CoreError("capability_denied", "local new placement is not selected");
    const base = task.worktree ? "HEAD" : task.brief.base ?? (task.brief.worktreeBase === "head" ? "HEAD" : execution.baseBranch) ??
      await admittedDefaultBase(ctx, task, providerId, attempt);
    worktreeGrant = await issueOwnedWorktreeGrant(ctx, task.id, providerId, attempt, base);
    workdir = worktreeGrant.workdir;
  }
  const prompt = buildPrompt(placement === "new" ? { ...task.brief,
    repo: task.worktree ? `${workdir} (the task worktree; keep its current branch; do not edit ${task.brief.repo} itself)` :
      `${workdir} (a new git worktree of ${task.brief.repo} on branch pacer/${task.id}; do not edit ${task.brief.repo} itself)` }
    : task.brief, task.id, !!ctx.env.PACER_WORK_GRANT);
  const launch = launchFor(cfg, prompt, workdir, dir, task.id);
  if (launch.argv.length < 1 || launch.argv.length > 32 ||
    launch.argv.some(arg => !arg || Buffer.byteLength(arg, "utf8") > 4096 || arg.includes("\0")) ||
    launch.stdin !== undefined && Buffer.byteLength(launch.stdin, "utf8") > 262144)
    throw new CoreError("invalid_input", "executor launch exceeds the bounded plugin contract");
  const selected = ctx.which(launch.argv[0]!);
  if (!selected) throw new CoreError("plugin_unavailable", "executor binary is unavailable");
  const executable = realpathSync(selected), stat = statSync(executable);
  if (!stat.isFile() || !(stat.mode & 0o111))
    throw new CoreError("plugin_unavailable", "executor binary is not executable");
  const env = executorEnv(ctx.env, await providerEnv(ctx, cfg), task.id);
  const cleanEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const admitted = readTask(ctx, task.id);
  if (!admitted || admitted.state !== "running" || admitted.stopPending ||
    admitted.executorProvider !== providerId || admitted.attempts.length + 1 !== attempt ||
    admitted.executor !== cfg.id || admitted.run)
    throw new CoreError("conflict", "executor owner changed before provider call");
  const resources: CallResources = { reads: [], commands: [], stores: [],
    ...(worktreeGrant ? { worktree: worktreeGrant } : {}),
    executorClaim: { taskId: task.id, attempt, providerId, executor: cfg.id,
      workdir, launch: { argv: launch.argv, cwd: workdir, executable,
        executableIdentity: { dev: stat.dev, ino: stat.ino, size: stat.size,
          mtimeMs: stat.mtimeMs, mode: stat.mode }, env: cleanEnv,
        ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }) } } };
  const raw = await caller.call(ctx, providerId, "executor.run",
    { task: { id: task.id, rev: admitted.rev }, attempt, runDir: 1,
      owned: { placement, timeoutMs: task.timeoutS * 1000,
        executor: cfg.id, model: cfg.model ?? null } },
    { resources, onProgress: () => {}, deadlineMs: task.timeoutS * 1000 + 10_000 });
  const parsed = executorAttemptOutcome.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "direct executor returned an invalid attempt outcome");
  const out = parsed.data;
  const durable = inspectOwnedExecutorRun(ctx, task.id, attempt), latest = readTask(ctx, task.id);
  if (!latest || latest.executorProvider !== providerId || latest.run?.workdir !== workdir ||
    latest.startIntent?.attempt !== attempt || latest.startIntent.providerId !== providerId ||
    durable.state !== "exited" || durable.exitCode !== out.exec.code ||
    out.attempt.executor !== cfg.id || out.attempt.model !== (cfg.model ?? null) ||
    out.attempt.exitCode !== out.exec.code || out.attempt.timedOut !== out.exec.timedOut ||
    out.attempt.startedAt !== latest.run.startedAt || out.attempt.log !== latest.run.logFile ||
    (placement === "new" ? out.worktree !== workdir || latest.worktree !== workdir ||
      latest.run.mode !== "new" : out.worktree !== undefined || latest.run.mode !== "current"))
    throw new CoreError("conflict", "direct executor outcome is not bound to its persisted run");
  withTaskLock(ctx, task.id, () => {
    const owned = readTask(ctx, task.id);
    if (!owned || owned.state !== "running" || owned.executorProvider !== providerId ||
      owned.run?.dir !== durable.dir || owned.run?.startedAt !== latest.run!.startedAt ||
      owned.startIntent?.attempt !== attempt || owned.startIntent.providerId !== providerId)
      throw new CoreError("conflict", "direct executor owner changed before exit receipt");
    const confirmed = inspectOwnedExecutorRun(ctx, task.id, attempt);
    if (confirmed.state !== "exited" || confirmed.exitCode !== durable.exitCode ||
      confirmed.dir !== durable.dir)
      throw new CoreError("conflict", "direct executor exit changed before receipt");
    updateTask(ctx, task.id, current => {
      current.executorExitReceipt = { attempt, providerId, dir: durable.dir,
        startedAt: owned.run!.startedAt, exitCode: durable.exitCode! };
    });
  });
  return out as AttemptOutcome;
}

export const runOwnedDirectCurrent = (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  caller: ExecutorCaller = pluginRegistry(ctx)): Promise<AttemptOutcome> =>
  runOwnedDirect(ctx, cfg, task, "current", caller);

export const runOwnedDirectNew = (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  caller: ExecutorCaller = pluginRegistry(ctx)): Promise<AttemptOutcome> =>
  runOwnedDirect(ctx, cfg, task, "new", caller);

/** The provider owns a selected remote pipe attempt; the host issues exact run effects. */
export async function runOwnedDirectRemote(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  caller: ExecutorCaller = pluginRegistry(ctx)): Promise<AttemptOutcome> {
  const nextAttempt = task.attempts.length + 1;
  if (task.remotePrepareIntent && task.remotePrepareIntent.attempt !== nextAttempt) {
    withTaskLock(ctx, task.id, () => {
      const settled = readTask(ctx, task.id), prior = settled?.remotePrepareIntent,
        receipt = settled?.executorExitReceipt;
      if (!settled || !prior || prior.attempt >= nextAttempt ||
        settled.attempts.length + 1 !== nextAttempt || !receipt ||
        receipt.attempt !== prior.attempt || receipt.providerId !== "pacer-exec-direct" ||
        settled.attempts[prior.attempt - 1]?.exitCode !== receipt.exitCode ||
        settled.attempts[prior.attempt - 1]?.startedAt !== receipt.startedAt ||
        settled.run || settled.stopPending)
        throw new CoreError("conflict", "prior remote attempt is not settled");
      updateTask(ctx, task.id, record => {
        delete record.remotePrepareIntent;
        delete record.remoteTransferIntent;
        delete record.remoteTransferNoWork;
        delete record.startIntent;
        delete record.executorExitReceipt;
        delete record.baseFetchIntent;
      });
    });
  }
  const providerId = "pacer-exec-direct", current = readTask(ctx, task.id);
  const strategy = loadStrategy(ctx), runner = resolveRunner(strategy, cfg.id);
  const alias = runner?.host, host = alias && strategy.hosts[alias];
  if (!current || !runner || !alias || !host || host.paused ||
    current.state !== "running" || current.stopPending || current.executorProvider !== providerId ||
    current.executor !== cfg.id || task.interactionMode === "conversation" || cfg.session === "interactive" ||
    host.session === "full" || validateExecution(strategy.execution).session === "pty" ||
    current.attempts.length !== task.attempts.length ||
    !Number.isSafeInteger(task.timeoutS) || task.timeoutS < 1 || task.timeoutS > 1800)
    throw new CoreError("capability_denied", "direct executor route is not an owned remote pipe attempt");
  const attempt = current.attempts.length + 1;
  let resources: CallResources = { reads: [], commands: [], stores: [],
    remoteTransfer: { taskId: task.id, attempt, providerId } };
  if (!current.run) {
    const git = await gitInfo(ctx.run, task.brief.repo);
    if ("error" in git) throw new CoreError("capability_denied", "remote source repository is unavailable");
    const base = current.remotePrepareIntent?.base ?? task.brief.base ??
      (task.brief.worktreeBase === "head" ? "HEAD" : validateExecution(strategy.execution).baseBranch) ??
      await admittedDefaultBase(ctx, task, providerId, attempt);
    const resolved = await resolveWorktreeBase(ctx, git.top, task.brief, base, false);
    if ("error" in resolved) throw new CoreError("conflict", resolved.error);
    const prepared = await admitOwnedRemotePrepare(ctx, task.id, providerId,
      cfg.id, alias, resolved.base, resolved.sha);
    resources = { ...resources, remotePrepare: { grant: prepared.grant } };
  } else {
    const run = current.run;
    if (run.attempt !== attempt || run.executor !== cfg.id || run.host !== alias ||
      !run.remoteDir || !run.remoteWorktree || !current.remotePrepareIntent ||
      run.baseSha !== current.remotePrepareIntent.baseSha ||
      !current.startIntent || current.startIntent.attempt !== attempt ||
      current.startIntent.providerId !== providerId || current.startIntent.dir !== run.dir)
      throw new CoreError("capability_denied", "remote run is uncertain; replacement launch refused");
  }
  const admitted = readTask(ctx, task.id)!;
  const run = admitted.run;
  const raw = await caller.call(ctx, providerId, "executor.run", {
    task: { id: task.id, rev: admitted.rev }, attempt, runDir: 1,
    remote: { timeoutMs: task.timeoutS * 1000, executor: cfg.id, model: cfg.model ?? null,
      ...(run ? { resume: { startedAt: run.startedAt, logFile: run.logFile } } : {}) },
  }, { resources, onProgress: () => {},
    deadlineMs: Math.max(5_000, (run?.startedAt ?? Date.now() / 1000) * 1000 +
      task.timeoutS * 1000 - Date.now() + 150_000) });
  const parsed = executorAttemptOutcome.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "remote executor returned an invalid outcome");
  const out = parsed.data, latest = readTask(ctx, task.id), persisted = latest?.run,
    receipt = latest?.executorExitReceipt;
  if (!latest || !persisted || !receipt || latest.state !== "running" || latest.stopPending ||
    latest.executorProvider !== providerId ||
    persisted.host !== alias || persisted.executor !== cfg.id || persisted.attempt !== attempt ||
    receipt.attempt !== attempt || receipt.providerId !== providerId ||
    receipt.dir !== persisted.dir || receipt.startedAt !== persisted.startedAt ||
    receipt.exitCode !== out.exec.code || out.attempt.exitCode !== out.exec.code ||
    out.attempt.startedAt !== persisted.startedAt || out.attempt.log !== persisted.logFile ||
    out.attempt.executor !== cfg.id || out.attempt.model !== (cfg.model ?? null) ||
    out.exec.timedOut || out.attempt.timedOut || out.attempt.limitHit ||
    out.partial !== undefined || out.takeover || out.attempt.brokenReason !== undefined ||
    out.backend !== "direct")
    throw new CoreError("conflict", "remote executor outcome is not bound to its persisted run");
  if (persisted.transferredHead) {
    const transfer = latest.remoteTransferIntent, git = await gitInfo(ctx.run, latest.brief.repo);
    if (!transfer || "error" in git || transfer.attempt !== attempt ||
      transfer.providerId !== providerId || transfer.dir !== persisted.dir ||
      transfer.startedAt !== persisted.startedAt || !out.worktree ||
      out.worktree !== taskWorktreePath(ctx, git.top, task.id))
      throw new CoreError("conflict", "remote transfer outcome has no matching local worktree");
    const ref = await ctx.run(["git", "-C", git.top, "rev-parse", "--verify",
      `refs/heads/${transfer.branch}`], 10_000);
    const head = await ctx.run(["git", "-C", out.worktree, "rev-parse", "--verify", "HEAD"], 10_000);
    if (ref.code !== 0 || ref.timedOut || head.code !== 0 || head.timedOut ||
      ref.stdout.trim() !== persisted.transferredHead ||
      head.stdout.trim() !== persisted.transferredHead)
      throw new CoreError("conflict", "remote transfer head changed after provider result");
  } else {
    const noWork = latest.remoteTransferNoWork;
    if (out.worktree !== undefined || receipt.exitCode === 0 || !noWork ||
      noWork.attempt !== attempt || noWork.providerId !== providerId ||
      noWork.dir !== persisted.dir || noWork.startedAt !== persisted.startedAt ||
      noWork.exitCode !== receipt.exitCode)
      throw new CoreError("conflict", "remote transfer outcome lacks a host-verified disposition");
  }
  return out as AttemptOutcome;
}

/** Reattach to the same persisted wrapper with read authority only; never claim or start again. */
export async function resumeOwnedDirect(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  caller: ExecutorCaller = pluginRegistry(ctx)): Promise<AttemptOutcome> {
  const providerId = "pacer-exec-direct", run = task.run;
  if (!run || task.state !== "running" || task.stopPending || task.executorProvider !== providerId ||
    run.host || run.executor !== cfg.id || task.executor !== cfg.id ||
    run.attempt !== task.attempts.length + 1 || task.startIntent?.attempt !== run.attempt ||
    task.startIntent.providerId !== providerId || task.startIntent.dir !== run.dir)
    throw new CoreError("capability_denied", "executor resume is not bound to an owned local run");
  const observed = inspectOwnedExecutorRun(ctx, task.id, run.attempt), dir = lstatSync(run.dir);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && dir.uid !== process.getuid()))
    throw new CoreError("capability_denied", "executor resume directory changed");
  const resources: CallResources = { reads: [], commands: [], stores: [],
    executorObserve: { taskId: task.id, attempt: run.attempt, providerId,
      executor: cfg.id, workdir: run.workdir, dir: run.dir,
      dirIdentity: { dev: dir.dev, ino: dir.ino }, startedAt: run.startedAt } };
  const raw = await caller.call(ctx, providerId, "executor.run", {
    task: { id: task.id, rev: observed.task.rev }, attempt: run.attempt, runDir: 1,
    owned: { placement: run.mode, timeoutMs: task.timeoutS * 1000,
      executor: cfg.id, model: cfg.model ?? null,
      resume: { startedAt: run.startedAt, logFile: run.logFile,
        ...(run.mode === "new" ? { worktree: run.workdir } : {}) } },
  }, { resources, onProgress: () => {}, deadlineMs: Math.max(5_000,
    run.startedAt * 1000 + task.timeoutS * 1000 - Date.now() + 10_000) });
  const parsed = executorAttemptOutcome.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "executor resume returned an invalid attempt outcome");
  const out = parsed.data, durable = inspectOwnedExecutorRun(ctx, task.id, run.attempt);
  if (durable.state !== "exited" || durable.exitCode !== out.exec.code ||
    out.attempt.executor !== cfg.id || out.attempt.model !== (cfg.model ?? null) ||
    out.attempt.exitCode !== out.exec.code || out.attempt.timedOut !== out.exec.timedOut ||
    out.attempt.startedAt !== run.startedAt || out.attempt.log !== run.logFile ||
    (run.mode === "new" ? out.worktree !== run.workdir : out.worktree !== undefined))
    throw new CoreError("conflict", "executor resume outcome does not match the persisted wrapper");
  withTaskLock(ctx, task.id, () => {
    const latest = readTask(ctx, task.id);
    if (!latest || latest.state !== "running" || latest.executorProvider !== providerId ||
      latest.run?.dir !== run.dir || latest.run.startedAt !== run.startedAt ||
      latest.stopPending || latest.attempts.length + 1 !== run.attempt)
      throw new CoreError("conflict", "executor resume owner changed before receipt");
    const checked = inspectOwnedExecutorRun(ctx, task.id, run.attempt);
    if (checked.state !== "exited" || checked.exitCode !== durable.exitCode)
      throw new CoreError("conflict", "executor resume exit changed before receipt");
    updateTask(ctx, task.id, current => {
      current.executorExitReceipt = { attempt: run.attempt, providerId,
        dir: run.dir, startedAt: run.startedAt, exitCode: checked.exitCode! };
    });
  });
  return out as AttemptOutcome;
}
