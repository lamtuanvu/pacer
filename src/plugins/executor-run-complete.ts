import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readRun, stopRun } from "../supervisor/run";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "interactive report owner or run changed"); };

/** The provider can finish only a reported, host-issued interactive wrapper. */
export async function answerExecutorReportedCompletion(authority: CallAuthority,
  params: { taskId: string; attempt: number }): Promise<{
    status: "done" | "failed"; summary: string; at: number; exitCode: number }> {
  const grant = authority.observedRun(params.taskId, params.attempt);
  const check = () => withTaskLock(authority.ctx, params.taskId, () => {
    authority.assertActive();
    const task = readTask(authority.ctx, params.taskId), run = task?.run;
    if (!task || task.state !== "running" || task.stopPending ||
      task.executorProvider !== grant.providerId || task.executor !== grant.executor ||
      task.attempts.length + 1 !== params.attempt || !run || run.host ||
      run.session !== "interactive" || run.attempt !== params.attempt ||
      run.dir !== grant.dir || run.startedAt !== grant.startedAt ||
      run.workdir !== grant.workdir || task.startIntent?.attempt !== params.attempt ||
      task.startIntent.providerId !== grant.providerId || task.startIntent.dir !== grant.dir ||
      grant.dir !== join(authority.ctx.pacerHome, "runs", params.taskId, String(params.attempt))) return deny();
    try {
      const dir = lstatSync(grant.dir);
      if (!dir.isDirectory() || dir.dev !== grant.dirIdentity.dev ||
        dir.ino !== grant.dirIdentity.ino || (dir.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && dir.uid !== process.getuid()) ||
        realpathSync(grant.dir) !== join(realpathSync(authority.ctx.pacerHome),
          "runs", params.taskId, String(params.attempt))) return deny();
      const state = readRun(grant.dir), report = state.report;
      if (!state.interactive || !report || !["done", "failed"].includes(report.status) ||
        !report.summary || report.summary.length > 16_000 || !Number.isFinite(report.at)) return deny();
      return { status: report.status as "done" | "failed", summary: report.summary,
        at: report.at, exit: state.exit };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      return deny();
    }
  });
  const before = check();
  authority.consumeExecutorComplete(params.taskId, params.attempt);
  const stable = () => {
    const current = check();
    if (current.status !== before.status || current.summary !== before.summary ||
      current.at !== before.at) return deny();
    return current;
  };
  try {
    const stopped = await stopRun(grant.dir, { graceMs: 5000, requireRecordedExit: true,
      guard: () => { stable(); } });
    const after = stable();
    if (after.exit === null || after.exit !== stopped.code) return deny();
    withTaskLock(authority.ctx, params.taskId, () => {
      stable();
      updateTask(authority.ctx, params.taskId, task => {
        task.executorReportReceipt = { attempt: params.attempt, providerId: grant.providerId,
          dir: grant.dir, startedAt: grant.startedAt, status: before.status,
          summary: before.summary, at: before.at, exitCode: stopped.code };
      });
    });
    return { status: before.status, summary: before.summary, at: before.at,
      exitCode: stopped.code };
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("plugin_unavailable", "interactive completion has no verified exit receipt");
  }
}
