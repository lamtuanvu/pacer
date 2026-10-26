import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readRun, stopRun } from "../supervisor/run";
import { readTask, withTaskLock } from "../tasks/store";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "detached stop owner or run changed"); };

/** Stop only the exact host-issued local pipe wrapper; the plugin cannot name a PID or path. */
export async function answerDetachedStop(authority: CallAuthority, params: {
  taskId: string; attempt: number; graceMs: number
}): Promise<{ code: number; killed: boolean }> {
  const grant = authority.consumeDetachedStop(params.taskId, params.attempt, params.graceMs);
  const active = (effect?: "signal" | "write") => withTaskLock(authority.ctx, grant.taskId, () => {
    authority.assertActive();
    const task = readTask(authority.ctx, grant.taskId);
    if (!task || task.rev !== grant.rev || task.state !== "running" || !task.run || task.run.host ||
      task.run.attempt !== grant.attempt || task.run.dir !== grant.dir ||
      task.run.startedAt !== grant.startedAt || task.run.executor !== grant.executor ||
      task.executor !== grant.executor || task.attempts.length + 1 !== grant.attempt ||
      grant.dir !== join(authority.ctx.pacerHome, "runs", grant.taskId, String(grant.attempt))) return deny();
    try {
      const dir = lstatSync(grant.dir), run = readRun(grant.dir);
      if (!dir.isDirectory() || dir.dev !== grant.dirIdentity.dev || dir.ino !== grant.dirIdentity.ino ||
        (dir.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && dir.uid !== process.getuid()) ||
        realpathSync(grant.dir) !== join(realpathSync(authority.ctx.pacerHome), "runs", grant.taskId, String(grant.attempt)) ||
        run.pid !== grant.pid || existsSync(join(grant.dir, "session.json")) ||
        (effect === "signal" && !run.alive)) return deny();
    } catch { return deny(); }
  });
  active();
  try {
    const result = await stopRun(grant.dir, { graceMs: grant.graceMs, pipeOnly: true,
      requireRecordedExit: true, guard: effect => active(effect) });
    active();
    return result;
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("plugin_unavailable", "detached stop has no verified completion receipt");
  }
}
