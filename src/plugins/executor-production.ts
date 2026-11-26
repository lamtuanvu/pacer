import { activeDeadlineExpired, humanDriving } from "../supervisor/active-time";
import { EXECUTOR_ARGV_BYTES } from "../exec/launch";
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { gitInfo, realpathSafe } from "../core/git";
import { heldOpenForHuman } from "../messaging/participants";
import { loadStrategy, type ProviderCfg } from "../config/strategy";
import { parseRunnerId, resolveRunner } from "../config/runner-id";
import { IDLE_FAIL_S, validateExecution } from "../config/execution";
import { providerRetryingReason } from "../exec/broken";
import { launchModeFor } from "../exec/launch";
import { loadExec, outcome } from "../exec/direct";
import { buildPrompt } from "../exec/prompt";
import { resolveWorktreeBase, taskWorktreePath } from "../supervisor/worktree";
import { readRun, stopRun } from "../supervisor/run";
import { LIMIT_QUIET_S, detectLimit, detectSessionLimit, sessionLimitExcerpt, sessionLimitText } from "../exec/limits";
import type { AttemptOutcome } from "../exec/direct";
import { readTask, tasksDir, updateTask, withTaskLock } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { pluginRegistry } from "./index";
import { executorAttemptOutcome } from "./executor-protocol";
import { inspectOwnedExecutorRun } from "./executor-run-state";
import { issueOwnedWorktreeGrant } from "./executor-worktree";
import { admitOwnedRemotePrepare } from "./executor-remote-prepare";
import type { CallResources } from "./authority";
import { checkoutOccupied } from "./executor-checkout";
import { planOwnedLaunch } from "./executor-launch-plan";
import { type RunMonitor, startRunMonitor } from "./executor-run-monitor";

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
  const providerId = "pacer-exec-direct";
  // A managed retry retains the task-owned checkout. Keep the prior receipts
  // until the new attempt replaces them, including across a crash before claim.
  if (!task.retryOf && task.attempts.length > 0) {
    withTaskLock(ctx, task.id, () => {
      const owned = readTask(ctx, task.id), previous = owned?.attempts.length ?? 0;
      const receipt = owned?.executorExitReceipt, start = owned?.startIntent;
      if (!owned || owned.state !== "running" || owned.stopPending || owned.run || owned.runClaim ||
        owned.executorProvider !== providerId || owned.attempts.length !== task.attempts.length ||
        owned.worktree !== task.worktree || !receipt || receipt.attempt !== previous ||
        receipt.providerId !== providerId || !start || start.attempt !== previous ||
        start.providerId !== providerId || start.dir !== receipt.dir ||
        owned.attempts[previous - 1]?.exitCode !== receipt.exitCode ||
        owned.attempts[previous - 1]?.startedAt !== receipt.startedAt ||
        owned.worktreeIntent && (placement !== "new" ||
          owned.worktreeIntent.attempt !== previous + 1))
        throw new CoreError("conflict", "prior local attempt is not settled");
    });
  }
  const current = readTask(ctx, task.id);
  if (!current || current.state !== "running" || current.stopPending || current.run ||
    current.executorProvider !== providerId || current.executor !== cfg.id ||
    current.attempts.length !== task.attempts.length ||
    current.brief.repo !== task.brief.repo || task.interactionMode === "conversation" ||
    heldOpenForHuman(ctx, task) ||
    parseRunnerId(cfg.id)?.host ||
    current.worktreeIntent && (placement !== "new" ||
      current.worktreeIntent.providerId !== providerId ||
      current.worktreeIntent.attempt !== current.attempts.length + 1) ||
    // A retry may record worktree === brief.repo when reusing an in-place checkout; that is not isolated.
    current.worktree && realpathSafe(current.worktree) !== realpathSafe(current.brief.repo) &&
      (placement !== "new" || !current.retryOf && current.attempts.length === 0))
    throw new CoreError("capability_denied", "direct executor route is not an owned local attempt");
  if (!Number.isSafeInteger(task.timeoutS) || task.timeoutS < 1 || task.timeoutS > 14400)
    throw new CoreError("invalid_input", "direct executor timeout must be between 1 and 14400 seconds");
  const strategy = loadStrategy(ctx), execution = validateExecution(strategy.execution);
  const attempt = current.attempts.length + 1, dir = join(ctx.pacerHome, "runs", task.id, String(attempt));
  let worktreeGrant: Awaited<ReturnType<typeof issueOwnedWorktreeGrant>> | undefined;
  let workdir: string, inPlaceTop: string | undefined, repoRoots: string[], trustRoot: string | undefined;
  if (placement === "current") {
    if (current.placement?.requested === "new" || current.placement?.mode === "new" ||
      current.placement?.requested !== "current" && execution.worktree !== "current" &&
        current.placement?.mode !== "current")
      throw new CoreError("capability_denied", "local current placement is not selected");
    const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
    if (current.placement?.why === "strategy default" && !("error" in git) && git.dirty)
      throw new CoreError("capability_denied", "current checkout has uncommitted changes");
    inPlaceTop = realpathSafe("error" in git ? task.brief.repo : git.top);
    if (checkoutOccupied(ctx, task.id, inPlaceTop))
      throw new CoreError("capability_denied", "current checkout is owned by another task");
    workdir = realpathSync(task.brief.repo);
    repoRoots = [task.brief.repo, ...("error" in git ? [] : [git.top, git.main])];
    trustRoot = "error" in git ? undefined : git.main;
  } else {
    if (current.placement?.requested === "current" || current.placement?.mode === "current" ||
      current.placement?.requested !== "new" && execution.worktree === "current")
      throw new CoreError("capability_denied", "local new placement is not selected");
    const base = task.worktree ? "HEAD" : task.brief.base ?? (task.brief.worktreeBase === "head" ? "HEAD" : execution.baseBranch) ??
      await admittedDefaultBase(ctx, task, providerId, attempt);
    worktreeGrant = await issueOwnedWorktreeGrant(ctx, task.id, providerId, attempt, base);
    workdir = worktreeGrant.workdir;
    repoRoots = [task.brief.repo, worktreeGrant.repoTop, worktreeGrant.repoMain];
    trustRoot = worktreeGrant.repoMain;
  }
  const brief = buildPrompt(placement === "new" ? { ...task.brief,
    repo: task.worktree ? `${workdir} (the task worktree; keep its current branch; do not edit ${task.brief.repo} itself)` :
      `${workdir} (a new git worktree of ${task.brief.repo} on branch pacer/${task.id}; do not edit ${task.brief.repo} itself)` }
    : task.brief, task.id, !!ctx.env.PACER_WORK_GRANT, { kind: task.kind });
  const plan = await planOwnedLaunch(ctx, { cfg, task, execution, placement, workdir, dir, brief, repoRoots, trustRoot });
  cfg = plan.cfg;
  if (plan.refused !== undefined) {
    const log = join(tasksDir(ctx), `${task.id}.${cfg.id}.log`);
    return outcome(cfg, Date.now() / 1000, { code: 1, stdout: "", stderr: plan.refused, timedOut: false }, log, plan.refused);
  }
  const { interactive, launch } = plan;
  if (launch.argv.length < 1 || launch.argv.length > 32 ||
    launch.argv.some(arg => !arg || Buffer.byteLength(arg, "utf8") > EXECUTOR_ARGV_BYTES || arg.includes("\0")) ||
    launch.stdin !== undefined && Buffer.byteLength(launch.stdin, "utf8") > 262144 ||
    plan.files.some(file => file.name === "prompt.md" && Buffer.byteLength(file.content, "utf8") > 8 * 1024 * 1024))
    throw new CoreError("invalid_input", "executor launch exceeds the plugin limits (4096 bytes per argument, 262144 bytes stdin, 8 MiB prompt file)");
  const selected = ctx.which(launch.argv[0]!);
  if (!selected) throw new CoreError("plugin_unavailable", "executor binary is unavailable");
  const executable = realpathSync(selected), stat = statSync(executable);
  if (!stat.isFile() || !(stat.mode & 0o111))
    throw new CoreError("plugin_unavailable", "executor binary is not executable");
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
          mtimeMs: stat.mtimeMs, mode: stat.mode }, env: plan.env,
        ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
        ...(interactive ? { session: "interactive" as const } : {}),
        ...(plan.files.length ? { files: plan.files } : {}),
        ...(plan.umask === undefined ? {} : { umask: plan.umask }),
        ...(plan.keepColor === undefined ? {} : { keepColor: plan.keepColor }) },
      ...(inPlaceTop === undefined ? {} : { inPlaceTop }),
      ...(plan.agentSession ? { agentSession: plan.agentSession } : {}),
      ...(plan.turnResume ? { turnResume: plan.turnResume } : {}) } };
  let raw: unknown;
  // The call is pending for the whole run (or one lease of it); the monitor watches the run meanwhile.
  const monitor = startRunMonitor(ctx, task.id, dir);
  try { raw = await caller.call(ctx, providerId, "executor.run",
    { task: { id: task.id, rev: admitted.rev }, attempt, runDir: 1,
      owned: { placement, timeoutMs: task.timeoutS * 1000,
        ...(interactive ? { session: "interactive" as const } : {}),
        executor: cfg.id, model: cfg.model ?? null } },
    { resources, onProgress: () => {}, deadlineMs: interactive ? 60_000 : task.timeoutS * 1000 + 10_000 });
  } catch (error) {
    let renewed = false;
    try {
      if (interactive) await stopAtSessionLimit(ctx, task.id, error, {attempt, dir, executor: cfg.id});
      renewed = interactive && renewInteractive(ctx, task.id, error, {attempt, dir, executor: cfg.id});
    } finally { if (!renewed) await monitor.stop(); }
    if (!renewed) throw error;
    // The resumed observation keeps the same monitor, so one poller sees the whole run.
    try { return await resumeOwned(ctx, cfg, readTask(ctx, task.id)!, caller, monitor); } finally { await monitor.stop(); }
  }
  await monitor.stop();
  const parsed = executorAttemptOutcome.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "direct executor returned an invalid attempt outcome");
  const out = parsed.data;
  if (!interactive) {
    if (launch.lastMessageFile && existsSync(launch.lastMessageFile)) {
      const last = readFileSync(launch.lastMessageFile, "utf8").trim().slice(-4000);
      if (last) out.report = last;
    }
    out.attempt.limitHit = detectLimit(cfg.id, out.exec);
  }
  out.report = plan.note + out.report;
  const durable = inspectOwnedExecutorRun(ctx, task.id, attempt), latest = readTask(ctx, task.id);
  const report = interactive ? readRun(durable.dir).report : null;
  const completion = latest?.executorReportReceipt;
  const validCompletion = !!completion && completion.attempt === attempt &&
    completion.providerId === providerId && completion.dir === durable.dir &&
    completion.startedAt === latest?.run?.startedAt && completion.exitCode === durable.exitCode &&
    report?.status === completion.status && report.summary === completion.summary &&
    report.at === completion.at;
  const logicalCode = interactive ? validCompletion ? completion.status === "done" ? 0 : 1
    : report?.status === "done" || report?.status === "failed" ? null
      : durable.exitCode === 0 ? 1 : durable.exitCode : durable.exitCode;
  if (!latest || latest.stopPending || latest.executorProvider !== providerId || latest.run?.workdir !== workdir ||
    latest.startIntent?.attempt !== attempt || latest.startIntent.providerId !== providerId ||
    latest.run.session !== (interactive ? "interactive" : undefined) ||
    durable.state !== "exited" || logicalCode === null || logicalCode !== out.exec.code ||
    out.attempt.executor !== cfg.id || out.attempt.model !== (cfg.model ?? null) ||
    out.attempt.exitCode !== out.exec.code || out.attempt.timedOut !== out.exec.timedOut ||
    out.attempt.startedAt !== latest.run.startedAt || out.attempt.log !== latest.run.logFile ||
    (placement === "new" ? out.worktree !== workdir || latest.worktree !== workdir ||
      latest.run.mode !== "new" : out.worktree !== undefined || latest.run.mode !== "current"))
    throw new CoreError("conflict", "direct executor outcome is not bound to its persisted run");
  // After the binding check: a verdict can raise an exit 0 the wrapper recorded to a failure.
  monitorOutcome(ctx, task.id, cfg.id, dir, out, interactive);
  withTaskLock(ctx, task.id, () => {
    const owned = readTask(ctx, task.id);
    if (!owned || owned.state !== "running" || owned.stopPending || owned.executorProvider !== providerId ||
      owned.run?.dir !== durable.dir || owned.run?.startedAt !== latest.run!.startedAt ||
      owned.startIntent?.attempt !== attempt || owned.startIntent.providerId !== providerId)
      throw new CoreError("conflict", "direct executor owner changed before exit receipt");
    const confirmed = inspectOwnedExecutorRun(ctx, task.id, attempt);
    if (confirmed.state !== "exited" || confirmed.exitCode !== durable.exitCode ||
      confirmed.dir !== durable.dir)
      throw new CoreError("conflict", "direct executor exit changed before receipt");
    updateTask(ctx, task.id, current => {
      current.executorExitReceipt = { attempt, providerId, dir: durable.dir,
        startedAt: owned.run!.startedAt, exitCode: out.exec.code };
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
  if (task.interactive !== false && launchModeFor(cfg, validateExecution(strategy.execution)).mode === "interactive")
    throw new CoreError("invalid_input", "Remote runners require explicitly configured headless execution");
  if (!current || !runner || !alias || !host || host.paused ||
    current.state !== "running" || current.stopPending || current.executorProvider !== providerId ||
    current.executor !== cfg.id || task.interactionMode === "conversation" ||
    heldOpenForHuman(ctx, task) || cfg.session === "interactive" ||
    host.session === "full" || validateExecution(strategy.execution).session === "pty" ||
    current.attempts.length !== task.attempts.length ||
    !Number.isSafeInteger(task.timeoutS) || task.timeoutS < 1 || task.timeoutS > 14400)
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
    resources = { ...resources, remoteObserve: { taskId: task.id, attempt, providerId,
      dir: run.dir, startedAt: run.startedAt } };
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
  const choice = launchModeFor(cfg, validateExecution(strategy.execution));
  if (choice.fallback) try { appendFileSync(out.attempt.log, `launch mode: headless (${choice.fallback})\n`); }
  catch { /* the attempt result stands */ }
  return out as AttemptOutcome;
}

/** Reattach to the same persisted wrapper with read authority only; never claim or start again. */
export const resumeOwnedDirect = (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  caller: ExecutorCaller = pluginRegistry(ctx)): Promise<AttemptOutcome> => resumeOwned(ctx, cfg, task, caller);

/** A resume started from a fresh attempt's lease renewal passes on that attempt's monitor; otherwise it starts its own. */
async function resumeOwned(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, caller: ExecutorCaller,
  inherited?: RunMonitor): Promise<AttemptOutcome> {
  const providerId = "pacer-exec-direct", run = task.run;
  if (!run || task.state !== "running" || task.stopPending || task.executorProvider !== providerId ||
    run.host || run.executor !== cfg.id || task.executor !== cfg.id ||
    run.attempt !== task.attempts.length + 1 || task.startIntent?.attempt !== run.attempt ||
    task.startIntent.providerId !== providerId || task.startIntent.dir !== run.dir) {
    await inherited?.stop();
    throw new CoreError("capability_denied", "executor resume is not bound to an owned local run");
  }
  const monitor = inherited ?? startRunMonitor(ctx, task.id, run);
  try { return await observeOwned(ctx, cfg, task, run, caller, monitor); } finally { await monitor.stop(); }
}

/** The resume's observation, under a monitor that is stopped before its outcome is classified. */
async function observeOwned(ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, run: NonNullable<TaskRecord["run"]>,
  caller: ExecutorCaller, monitor: RunMonitor): Promise<AttemptOutcome> {
  const providerId = "pacer-exec-direct";
  const observed = inspectOwnedExecutorRun(ctx, task.id, run.attempt), dir = lstatSync(run.dir);
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && dir.uid !== process.getuid()))
    throw new CoreError("capability_denied", "executor resume directory changed");
  const resources: CallResources = { reads: [], commands: [], stores: [],
    executorObserve: { taskId: task.id, attempt: run.attempt, providerId,
      executor: cfg.id, workdir: run.workdir, dir: run.dir,
      dirIdentity: { dev: dir.dev, ino: dir.ino }, startedAt: run.startedAt } };
  let raw: unknown;
  for (;;) {
  try { raw = await caller.call(ctx, providerId, "executor.run", {
    task: { id: task.id, rev: readTask(ctx, task.id)!.rev }, attempt: run.attempt, runDir: 1,
    owned: { placement: run.mode, timeoutMs: task.timeoutS * 1000,
      ...(run.session === "interactive" ? { session: "interactive" as const } : {}),
      executor: cfg.id, model: cfg.model ?? null,
      resume: { startedAt: run.startedAt, logFile: run.logFile,
        ...(run.mode === "new" ? { worktree: run.workdir } : {}) } },
  }, { resources, onProgress: () => {}, deadlineMs: run.session === "interactive" ? 60_000 : Math.max(5_000,
    run.startedAt * 1000 + task.timeoutS * 1000 - Date.now() + 10_000) });
    break;
  } catch (error) {
    if (run.session === "interactive") await stopAtSessionLimit(ctx, task.id, error, run);
    if (run.session !== "interactive" || !renewInteractive(ctx, task.id, error, run)) throw error;
  }
  }
  await monitor.stop();
  const parsed = executorAttemptOutcome.safeParse(raw);
  if (!parsed.success) throw new CoreError("plugin_refused", "executor resume returned an invalid attempt outcome");
  const out = parsed.data, durable = inspectOwnedExecutorRun(ctx, task.id, run.attempt);
  const report = run.session === "interactive" ? readRun(run.dir).report : null;
  const completion = readTask(ctx, task.id)?.executorReportReceipt;
  const validCompletion = !!completion && completion.attempt === run.attempt &&
    completion.providerId === providerId && completion.dir === run.dir &&
    completion.startedAt === run.startedAt && completion.exitCode === durable.exitCode &&
    report?.status === completion.status && report.summary === completion.summary &&
    report.at === completion.at;
  const logicalCode = run.session === "interactive" ? validCompletion ?
    completion.status === "done" ? 0 : 1 :
    report?.status === "done" || report?.status === "failed" ? null :
      durable.exitCode === 0 ? 1 : durable.exitCode : durable.exitCode;
  if (durable.state !== "exited" || logicalCode === null || logicalCode !== out.exec.code ||
    out.attempt.executor !== cfg.id || out.attempt.model !== (cfg.model ?? null) ||
    out.attempt.exitCode !== out.exec.code || out.attempt.timedOut !== out.exec.timedOut ||
    out.attempt.startedAt !== run.startedAt || out.attempt.log !== run.logFile ||
    (run.mode === "new" ? out.worktree !== run.workdir : out.worktree !== undefined))
    throw new CoreError("conflict", "executor resume outcome does not match the persisted wrapper");
  if (!validCompletion) monitorOutcome(ctx, task.id, cfg.id, run.dir, out, run.session === "interactive");
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
        dir: run.dir, startedAt: run.startedAt, exitCode: out.exec.code };
    });
  });
  return out as AttemptOutcome;
}

/** An interactive attempt that ended without a completion report while its screen shows the provider's limit error. */
export function sessionLimitOutcome(executor: string, dir: string, out: {exec: {code: number; timedOut: boolean}; report: string}): boolean {
  const reported = readRun(dir).report?.status;
  // An explicit done/failed report is authoritative, whatever the screen shows.
  if (out.exec.code === 0 || out.exec.timedOut || reported === "done" || reported === "failed") return false;
  const excerpt = sessionLimitExcerpt(executor, sessionLimitText(dir));
  if (excerpt === null) return false;
  out.report += `\n\nUsage limit reached:\n${excerpt}`;
  return true;
}

type MonitoredOutcome = {exec: {code: number; timedOut: boolean; stderr: string}; report: string; attempt: {limitHit: boolean; exitCode: number; brokenReason?: string}};

/**
 * The run monitor's persisted verdict for this run dir, unless an explicit done/failed report outranks it. An agent
 * that exits 0 on the monitor's stop still failed its attempt.
 */
function monitorVerdict(ctx: Ctx, id: string, dir: string, out: MonitoredOutcome, ended: (v: "limit" | "provider" | "idle") => boolean) {
  const banner = readTask(ctx, id)?.run, reported = readRun(dir).report?.status, verdict = banner?.retryBanner;
  if (banner?.dir !== dir || !verdict?.ended || !ended(verdict.ended) || out.exec.timedOut || reported === "done" || reported === "failed") return undefined;
  if (out.exec.code === 0) out.exec.code = out.attempt.exitCode = 1;
  return {...verdict, ended: verdict.ended};
}

/** Classify an attempt the run monitor may have stopped: its limit or retry-loop verdict, else the screen's limit; then an idle stop. */
function monitorOutcome(ctx: Ctx, id: string, executor: string, dir: string, out: MonitoredOutcome, interactive: boolean): void {
  if (interactive && !retryLoopOutcome(ctx, id, executor, dir, out) && sessionLimitOutcome(executor, dir, out)) out.attempt.limitHit = true;
  idleStopOutcome(ctx, id, dir, out);
}

/**
 * An attempt the run monitor stopped on its provider retry banner: a rate-limit banner (or a quiet limit screen) is a
 * limit, a transient one that outlasted its window marks the executor broken. The verdict is on the task's run, so it
 * survives a restart.
 */
export function retryLoopOutcome(ctx: Ctx, id: string, executor: string, dir: string, out: MonitoredOutcome): boolean {
  const banner = monitorVerdict(ctx, id, dir, out, v => v !== "idle");
  if (!banner) return false;
  const {ended, reason, since} = banner;
  if (ended === "limit") {
    out.attempt.limitHit = true;
    out.report += `\n\nUsage limit reached:\n${reason}`;
    return true;
  }
  const line = `pacer: ${executor} kept retrying a provider error for ${Math.round((Date.now() / 1000 - since) / 60)} min: ${reason}`;
  out.attempt.limitHit = false;
  out.attempt.brokenReason = providerRetryingReason(reason);
  out.exec.stderr += `\n${line}`;
  out.report += `\n\n${line}`;
  return true;
}

/** An attempt the run monitor stopped after idle_fail without output or file changes: a failure that says so. */
export function idleStopOutcome(ctx: Ctx, id: string, dir: string, out: MonitoredOutcome): boolean {
  if (!monitorVerdict(ctx, id, dir, out, v => v === "idle")) return false;
  const line = `pacer: stopped after ${Math.round((loadExec(ctx).idleFailS ?? IDLE_FAIL_S) / 60)} min without output or file changes`;
  out.exec.stderr += `\n${line}`;
  out.report += `\n\n${line}`;
  return true;
}

/**
 * An interactive agent that hits its plan limit prints the error and waits; nothing else ends the run. At each lease
 * renewal, stop a quiet session whose screen shows the error, so the observation sees an exit and the runner fails
 * over. The run monitor owns this check (and the retry banner) between renewals.
 */
export async function stopAtSessionLimit(ctx: Ctx, id: string, error: unknown, expected: {attempt: number; dir: string; executor: string}): Promise<void> {
  if (!(error instanceof CoreError) || error.code !== "plugin_timeout") return;
  const task = readTask(ctx, id), run = task?.run;
  if (!task || task.state !== "running" || task.stopPending || !run || run.host || run.session !== "interactive" ||
    run.interactionMode === "conversation" || run.takeover || run.attempt !== expected.attempt || run.dir !== expected.dir ||
    run.executor !== expected.executor || task.executorProvider !== "pacer-exec-direct") return;
  const state = readRun(run.dir);
  if (!state.alive || state.exit !== null || state.report?.status === "done" || state.report?.status === "failed") return;
  // A person typing in the session owns it; they can see the error themselves.
  if (humanDriving(state, Date.now())) return;
  const now = Date.now() / 1000;
  if (now - (state.lastOutputAt ?? now) < LIMIT_QUIET_S) return;
  if (!detectSessionLimit(run.executor, sessionLimitText(run.dir))) return;
  await stopRun(run.dir, {graceMs: 5000});
}

/** Renew a finite provider observation lease only while the same task still owns a live run. */
function renewInteractive(ctx: Ctx, id: string, error: unknown, expected: {attempt: number; dir: string; executor: string; startedAt?: number}): boolean {
  if (!(error instanceof CoreError) || error.code !== "plugin_timeout") return false;
  const task = readTask(ctx, id), run = task?.run;
  if (!task || task.state !== "running" || task.stopPending || !run || run.host || run.session !== "interactive") return false;
  if (run.attempt !== expected.attempt || run.dir !== expected.dir || run.executor !== expected.executor ||
    expected.startedAt !== undefined && run.startedAt !== expected.startedAt || task.executorProvider !== "pacer-exec-direct") return false;
  const state = readRun(run.dir);
  // A lease can expire after the durable exit/report but before the outcome arrived. Reobserve; never START again.
  if (state.exit !== null || state.report?.status === "done" || state.report?.status === "failed") return true;
  return state.alive && state.exit === null && !activeDeadlineExpired(run.dir, run.startedAt * 1000 + task.timeoutS * 1000, state);
}
