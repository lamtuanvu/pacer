import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { loadStrategy } from "../config/strategy";
import { resolveRunner } from "../config/runner-id";
import { validateExecution } from "../config/execution";
import { remoteLaunch } from "../exec/launch";
import { buildPrompt } from "../exec/prompt";
import { RemoteRunIO } from "../remote/run-io";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "owned remote run changed"); };

function owner(authority: CallAuthority, taskId: string, attempt: number) {
  authority.assertActive();
  const ctx = authority.ctx, task = readTask(ctx, taskId), run = task?.run,
    intent = task?.remotePrepareIntent;
  if (!task || !run || !intent || task.state !== "running" ||
    task.executorProvider !== "pacer-exec-direct" || task.executor !== intent.executor ||
    task.attempts.length + 1 !== attempt || run.attempt !== attempt ||
    run.executor !== intent.executor || run.host !== intent.alias ||
    run.remoteWorktree !== run.workdir ||
    !run.workdir.endsWith(`/.pacer-remote/worktrees/${intent.tag}/${taskId}-${attempt}`) ||
    ![`pacer/${taskId}`, `pacer/${taskId}-${attempt}`].includes(run.remoteBranch ?? "") ||
    task.worktree !== `${intent.alias}:${run.workdir}` ||
    run.baseSha !== intent.baseSha || !run.remoteDir ||
    intent.attempt !== attempt || intent.providerId !== task.executorProvider ||
    run.dir !== join(ctx.pacerHome, "runs", taskId, String(attempt))) return deny();
  const prefix = run.workdir.slice(0, -(`/.pacer-remote/worktrees/${intent.tag}/${taskId}-${attempt}`).length);
  if (run.remoteDir !== `${prefix}/.pacer-remote/runs/${taskId}/${attempt}`) return deny();
  const host = loadStrategy(ctx).hosts[intent.alias];
  if (!host || host.paused || JSON.stringify(host) !== intent.hostFingerprint ||
    host.session === "full" || validateExecution(loadStrategy(ctx).execution).session === "pty") return deny();
  const stat = lstatSync(run.dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid())) return deny();
  return { ctx, task, run, intent, host, identity: { dev: stat.dev, ino: stat.ino } };
}

/** Record START before any remote effect; a lost reply may only be observed. */
export async function answerOwnedRemoteStart(authority: CallAuthority,
  request: { taskId: string; attempt: number }): Promise<{ pid: number }> {
  const before = owner(authority, request.taskId, request.attempt);
  if (before.task.stopPending || before.task.startIntent || before.task.executorExitReceipt) return deny();
  const cfg = loadStrategy(before.ctx).providers[before.run.executor];
  const runner = resolveRunner(loadStrategy(before.ctx), before.run.executor);
  if (!cfg || !runner || !runner.host || runner.host !== before.intent.alias || cfg.session === "interactive") return deny();
  const launch = remoteLaunch(cfg, before.run.workdir, before.run.remoteDir!);
  let built = buildPrompt({ ...before.task.brief, repo: before.run.workdir }, request.taskId);
  const askRule = 'run pacer ask "<one question>" once, then stop';
  const askAt = built.lastIndexOf(askRule);
  if (askAt < 0) return deny();
  built = built.slice(0, askAt) +
    "write your one question (1–1000 characters) verbatim to .pacer-question in the worktree, leave that file uncommitted, then stop" +
    built.slice(askAt + askRule.length);
  const localRule = "- Do not commit, push, or change git branches.";
  const contractAt = built.lastIndexOf(localRule);
  if (contractAt < 0) return deny();
  const prompt = built.slice(0, contractAt) +
    `- Work only on ${before.run.remoteBranch} and commit there; don't push or change git config; leave the worktree clean.` +
    built.slice(contractAt + localRule.length);
  const env: Record<string, string> = { PACER_ROLE: "executor", PACER_TASK_ID: request.taskId };
  const home = before.host.accounts[runner.account ?? ""]?.home;
  if (home) env[runner.agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] = home;
  withTaskLock(before.ctx, request.taskId, () => {
    const current = owner(authority, request.taskId, request.attempt);
    if (current.task.stopPending || current.task.startIntent ||
      current.run.startedAt !== before.run.startedAt || current.identity.dev !== before.identity.dev ||
      current.identity.ino !== before.identity.ino) return deny();
    updateTask(before.ctx, request.taskId, task => {
      task.startIntent = { attempt: request.attempt, providerId: "pacer-exec-direct", dir: before.run.dir };
    });
  });
  const started = await new RemoteRunIO(before.ctx, before.host, before.run.remoteDir!, before.run.dir)
    .start(launch.argv, before.run.workdir, env, prompt, { session: "pipe" });
  if ("error" in started) throw new CoreError("plugin_refused", "remote START receipt is unverified");
  const after = owner(authority, request.taskId, request.attempt);
  if (after.run.startedAt !== before.run.startedAt || after.task.startIntent?.attempt !== request.attempt ||
    after.task.startIntent.providerId !== "pacer-exec-direct" ||
    after.task.startIntent.dir !== before.run.dir || after.identity.dev !== before.identity.dev ||
    after.identity.ino !== before.identity.ino) return deny();
  return { pid: started.pid };
}

/** Read only the exact persisted run. Uncertain reports never authorize another START. */
export async function answerOwnedRemotePoll(authority: CallAuthority,
  request: { taskId: string; attempt: number }): Promise<{ state: "running" | "exited" | "uncertain";
    exitCode: number | null }> {
  const before = owner(authority, request.taskId, request.attempt);
  if (!before.task.startIntent || before.task.startIntent.attempt !== request.attempt ||
    before.task.startIntent.providerId !== "pacer-exec-direct" ||
    before.task.startIntent.dir !== before.run.dir) return deny();
  const state = await new RemoteRunIO(before.ctx, before.host, before.run.remoteDir!, before.run.dir).read();
  const after = owner(authority, request.taskId, request.attempt);
  if (after.run.startedAt !== before.run.startedAt || after.identity.dev !== before.identity.dev ||
    after.identity.ino !== before.identity.ino ||
    JSON.stringify(after.task.startIntent) !== JSON.stringify(before.task.startIntent)) return deny();
  if (state.exit !== null) {
    if (!existsSync(join(before.run.dir, "admission.complete"))) return { state: "uncertain", exitCode: null };
    withTaskLock(before.ctx, request.taskId, () => {
      const current = owner(authority, request.taskId, request.attempt);
      if (current.run.startedAt !== before.run.startedAt ||
        JSON.stringify(current.task.startIntent) !== JSON.stringify(before.task.startIntent)) return deny();
      updateTask(before.ctx, request.taskId, task => {
        task.executorExitReceipt = { attempt: request.attempt, providerId: "pacer-exec-direct",
          dir: before.run.dir, startedAt: before.run.startedAt, exitCode: state.exit! };
      });
    });
    return { state: "exited", exitCode: state.exit };
  }
  return { state: state.alive ? "running" : "uncertain", exitCode: null };
}

/** Bounded tails only after a host-verified exit receipt. */
export function answerOwnedRemoteOutput(authority: CallAuthority,
  request: { taskId: string; attempt: number }): { stdoutBase64: string; stderrBase64: string } {
  const before = owner(authority, request.taskId, request.attempt), receipt = before.task.executorExitReceipt;
  if (!receipt || receipt.attempt !== request.attempt || receipt.providerId !== "pacer-exec-direct" ||
    receipt.dir !== before.run.dir || receipt.startedAt !== before.run.startedAt) return deny();
  const tail = (name: "stdout" | "stderr") => {
    let fd: number;
    try { fd = openSync(join(before.run.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      return deny();
    }
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || (process.getuid?.() !== undefined && file.uid !== process.getuid())) return deny();
      const bytes = Math.min(file.size, 256 * 1024), buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, file.size - bytes);
      return buffer.subarray(0, read).toString("base64");
    } finally { closeSync(fd); }
  };
  const stdoutBase64 = tail("stdout"), stderrBase64 = tail("stderr");
  const after = owner(authority, request.taskId, request.attempt);
  if (after.run.startedAt !== before.run.startedAt ||
    JSON.stringify(after.task.executorExitReceipt) !== JSON.stringify(receipt)) return deny();
  return { stdoutBase64, stderrBase64 };
}
