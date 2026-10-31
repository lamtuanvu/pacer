import { lstatSync } from "node:fs";
import { CoreError } from "../core/errors";
import { readTask, withTaskLock } from "../tasks/store";
import { inspectOwnedExecutorRun } from "./executor-run-state";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "detached inspection owner or run changed"); };

/** One-use, read-only observation of the host's exact persisted local wrapper. */
export function answerDetachedInspect(authority: CallAuthority,
  params: { taskId: string; attempt: number }): { state: "running" | "exited" | "uncertain" } {
  const grant = authority.consumeDetachedInspect(params.taskId, params.attempt);
  return withTaskLock(authority.ctx, grant.taskId, () => {
    authority.assertActive();
    const task = readTask(authority.ctx, grant.taskId);
    if (!task || task.rev !== grant.rev || task.state !== "running" || !task.run ||
      task.run.dir !== grant.dir || task.run.attempt !== grant.attempt ||
      task.run.startedAt !== grant.startedAt || task.run.executor !== grant.executor ||
      task.executor !== grant.executor || task.run.host) return deny();
    try {
      const dir = lstatSync(grant.dir);
      if (!dir.isDirectory() || dir.dev !== grant.dirIdentity.dev || dir.ino !== grant.dirIdentity.ino)
        return deny();
      const observed = inspectOwnedExecutorRun(authority.ctx, grant.taskId, grant.attempt);
      const after = lstatSync(grant.dir);
      if (observed.task.rev !== grant.rev || observed.dir !== grant.dir ||
        after.dev !== grant.dirIdentity.dev || after.ino !== grant.dirIdentity.ino) return deny();
      authority.assertActive();
      return { state: observed.state };
    } catch { return deny(); }
  });
}
