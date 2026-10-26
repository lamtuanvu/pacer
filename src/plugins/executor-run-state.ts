import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readRun } from "../supervisor/run";
import { readTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";
import { executorRunState } from "./executor-protocol";

const deny = (): never => { throw new CoreError("conflict", "executor run owner or directory changed"); };

/** Read one durable local attempt without trusting a caller-supplied path or PID. */
export function inspectOwnedExecutorRun(ctx: Ctx, taskId: string, attempt: number):
  ReturnType<typeof executorRunState.parse> {
  if (!/^t-[A-Za-z0-9_-]{1,120}$/.test(taskId) || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new CoreError("invalid_input", "invalid executor run identity");
  return withTaskLock(ctx, taskId, () => {
    const task = readTask(ctx, taskId);
    const dir = join(ctx.pacerHome, "runs", taskId, String(attempt));
    if (!task || task.state !== "running" || !task.run || task.run.host ||
      task.run.attempt !== attempt || task.run.dir !== dir ||
      task.run.executor !== task.executor || task.attempts.length + 1 !== attempt) return deny();
    let fd: number;
    try { fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch { return deny(); }
    try {
      const opened = fstatSync(fd), linked = lstatSync(dir);
      if (!opened.isDirectory() || !linked.isDirectory() || opened.dev !== linked.dev || opened.ino !== linked.ino ||
        (opened.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && opened.uid !== process.getuid()) ||
        realpathSync(dir) !== join(realpathSync(ctx.pacerHome), "runs", taskId, String(attempt))) return deny();
      for (const name of ["pid", "exit"]) {
        try { if (!lstatSync(join(dir, name)).isFile()) return deny(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return deny(); }
      }
      const state = readRun(dir);
      const after = lstatSync(dir);
      if (!after.isDirectory() || after.dev !== opened.dev || after.ino !== opened.ino) return deny();
      const parsed = executorRunState.safeParse({
        task: { id: taskId, rev: task.rev }, attempt, runDir: 1, dir,
        state: state.exit !== null ? "exited" : state.alive ? "running" : "uncertain",
        pid: state.pid, exitCode: state.exit, startedAt: state.startedAt,
        stdoutBytes: state.stdoutBytes, stderrBytes: state.stderrBytes,
      });
      if (!parsed.success) return deny();
      return parsed.data;
    } catch (error) {
      if (error instanceof CoreError) throw error;
      return deny();
    } finally { closeSync(fd); }
  });
}
