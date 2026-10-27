import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readTask, withTaskLock } from "../tasks/store";
import { publishOwnedExecutorRun } from "./executor-attempt";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "executor run claim owner changed"); };

/** A missing claim reply may be retried only while no process effect has begun. */
export async function answerExecutorClaim(authority: CallAuthority,
  params: { taskId: string; attempt: number }): Promise<{ task: { id: string; rev: number }; attempt: number; runDir: 1;
    dir: string; workdir: string; startedAt: number; logFile: string }> {
  const grant = authority.consumeExecutorClaim(params.taskId, params.attempt);
  const ctx = authority.ctx;
  const existing = readTask(ctx, grant.taskId)?.run;
  if (!existing) {
    try { await publishOwnedExecutorRun(ctx, grant.providerId, grant.taskId, grant.executor, grant.workdir,
      grant.launch.session); }
    catch (error) {
      if (error instanceof CoreError && error.code === "conflict") return deny();
      throw error;
    }
  }
  return withTaskLock(ctx, grant.taskId, () => {
    authority.assertActive();
    const task = readTask(ctx, grant.taskId), run = task?.run;
    const dir = join(ctx.pacerHome, "runs", grant.taskId, String(grant.attempt));
    if (!task || task.state !== "running" || task.stopPending ||
      task.executorProvider !== grant.providerId || task.executor !== grant.executor ||
      task.attempts.length + 1 !== grant.attempt || !run ||
      run.attempt !== grant.attempt || run.executor !== grant.executor ||
      run.dir !== dir || run.workdir !== grant.workdir || run.host ||
      run.session !== grant.launch.session ||
      run.interactionMode !== task.interactionMode ||
      (task.interactionMode === "conversation" &&
        (run.agentSession?.id !== task.nativeIdentityIntent?.id ||
          run.agentSession?.source !== task.nativeIdentityIntent?.source)) ||
      task.worktreeIntent || task.runClaim || task.startIntent?.attempt === grant.attempt) return deny();
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
        realpathSync(dir) !== join(realpathSync(ctx.pacerHome), "runs", grant.taskId, String(grant.attempt)) ||
        readdirSync(dir).length !== 0) return deny();
      const after = lstatSync(dir);
      if (after.dev !== stat.dev || after.ino !== stat.ino) return deny();
      const launch = grant.launch, executable = statSync(launch.executable), cwd = statSync(launch.cwd);
      if (realpathSync(launch.executable) !== launch.executable ||
        executable.dev !== launch.executableIdentity.dev || executable.ino !== launch.executableIdentity.ino ||
        executable.size !== launch.executableIdentity.size || executable.mtimeMs !== launch.executableIdentity.mtimeMs ||
        executable.mode !== launch.executableIdentity.mode || !(executable.mode & 0o111) ||
        realpathSync(launch.cwd) !== realpathSync(grant.workdir) ||
        !cwd.isDirectory()) return deny();
      authority.bindClaimedDetachedRun({ taskId: grant.taskId, rev: task.rev, attempt: grant.attempt,
        providerId: grant.providerId, executor: grant.executor, startedAt: run.startedAt,
        workdir: grant.workdir,
        dir, dirIdentity: { dev: stat.dev, ino: stat.ino }, argv: launch.argv, cwd: realpathSync(launch.cwd),
        executable: launch.executable, executableIdentity: launch.executableIdentity,
        cwdIdentity: { dev: cwd.dev, ino: cwd.ino }, env: launch.env,
        ...(launch.stdin === undefined ? {} : { stdin: launch.stdin }),
        ...(launch.session === undefined ? {} : { session: launch.session }),
        ...(launch.files === undefined ? {} : { files: launch.files }) });
    } catch { return deny(); }
    authority.assertActive();
    return { task: { id: grant.taskId, rev: task.rev }, attempt: grant.attempt, runDir: 1,
      dir, workdir: run.workdir, startedAt: run.startedAt, logFile: run.logFile };
  });
}
