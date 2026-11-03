import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { RunRef } from "../tasks/types";
import type { Ctx } from "../types";
import type { CallAuthority } from "./authority";
import { claimRunDirectory } from "./executor-attempt";

const deny = (): never => { throw new CoreError("capability_denied", "remote run claim owner changed"); };

/** Publish the exact remote run after verified placement and before START. */
export function answerOwnedRemoteClaim(authority: CallAuthority,
  request: { taskId: string; attempt: number }): { dir: string; worktree: string;
    remoteDir: string; branch: string; startedAt: number; logFile: string } {
  const { taskId, attempt } = request, ctx: Ctx = authority.ctx;
  const prepared = authority.remotePreparedRun(taskId, attempt);
  return withTaskLock(ctx, taskId, () => {
    authority.assertActive();
    const task = readTask(ctx, taskId), intent = task?.remotePrepareIntent;
    if (!task || !intent || task.state !== "running" || task.stopPending ||
      task.executorProvider !== "pacer-exec-direct" ||
      task.executor !== intent.executor || task.attempts.length + 1 !== attempt ||
      intent.attempt !== attempt || intent.providerId !== task.executorProvider ||
      !prepared.worktree.endsWith(`/.pacer-remote/worktrees/${intent.tag}/${taskId}-${attempt}`) ||
      ![`pacer/${taskId}`, `pacer/${taskId}-${attempt}`].includes(prepared.branch)) return deny();
    const prefix = prepared.worktree.slice(0, -(`/.pacer-remote/worktrees/${intent.tag}/${taskId}-${attempt}`).length);
    if (!prefix.startsWith("/") || prefix === "/" || prefix.includes("..")) return deny();
    const dir = join(ctx.pacerHome, "runs", taskId, String(attempt));
    const remoteDir = `${prefix}/.pacer-remote/runs/${taskId}/${attempt}`;
    const expected = { attempt, providerId: intent.providerId, executor: intent.executor,
      workdir: prepared.worktree, dir, host: intent.alias, remoteDir,
      remoteBranch: prepared.branch, baseSha: intent.baseSha };
    if (task.run) return deny();
    const recover = !!task.runClaim;
    if (recover && JSON.stringify(task.runClaim) !== JSON.stringify(expected)) return deny();
    if (!recover) updateTask(ctx, taskId, current => { current.runClaim = expected; });
    const claimed = claimRunDirectory(ctx, taskId, attempt, recover);
    if (claimed.path !== dir) return deny();
    const startedAt = Date.now() / 1000;
    const run: RunRef = { dir, attempt, executor: intent.executor, startedAt,
      mode: "new", workdir: prepared.worktree, logFile: join(dir, "stdout"),
      host: intent.alias, remoteDir, remoteWorktree: prepared.worktree,
      remoteBranch: prepared.branch, baseSha: intent.baseSha };
    updateTask(ctx, taskId, current => {
      if (JSON.stringify(current.runClaim) !== JSON.stringify(expected)) return deny();
      current.run = run;
      current.baseBranch = intent.base; current.baseSha = intent.baseSha;
      current.worktree = `${intent.alias}:${prepared.worktree}`;
      delete current.runClaim;
    });
    return { dir, worktree: prepared.worktree, remoteDir, branch: prepared.branch,
      startedAt, logFile: run.logFile };
  });
}
