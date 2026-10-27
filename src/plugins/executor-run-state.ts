import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readRun } from "../supervisor/run";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { Ctx } from "../types";
import { executorRunState } from "./executor-protocol";

const deny = (): never => { throw new CoreError("conflict", "executor run owner or directory changed"); };

/** Read one durable local attempt without trusting a caller-supplied path or PID. */
export function inspectOwnedExecutorRun(ctx: Ctx, taskId: string, attempt: number,
  bindConversationWrapper = false):
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
      for (const name of ["pid", "started", "exit"]) {
        try { if (!lstatSync(join(dir, name)).isFile()) return deny(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return deny(); }
      }
      const state = readRun(dir);
      const after = lstatSync(dir);
      if (!after.isDirectory() || after.dev !== opened.dev || after.ino !== opened.ino) return deny();
      let rev = task.rev;
      if (bindConversationWrapper) {
        const run = task.run, start = task.startIntent;
        if (task.interactionMode !== "conversation" || run.interactionMode !== "conversation" ||
          run.session !== "interactive" || !start || start.attempt !== attempt ||
          start.providerId !== task.executorProvider || start.dir !== dir ||
          run.wrapperStartedAt !== undefined && run.wrapperStartedAt !== state.startedAt ||
          run.wrapperPid !== undefined && run.wrapperPid !== state.pid) return deny();
        if (state.startedAt !== null && state.pid !== null) {
          if (state.startedAt < Math.floor(run.startedAt) - 1 ||
            state.startedAt > Math.floor(run.startedAt) + 30 ||
            task.childPid !== undefined && task.childPid !== state.pid) return deny();
        }
        if (state.startedAt !== null && state.pid !== null &&
          (run.wrapperStartedAt === undefined || run.wrapperPid === undefined)) {
          if (task.childPid === undefined || task.childPid !== state.pid) return deny();
          const updated = updateTask(ctx, taskId, current => {
            current.run!.wrapperStartedAt = state.startedAt!;
            current.run!.wrapperPid = state.pid!;
          });
          rev = updated.rev;
        }
      }
      const parsed = executorRunState.safeParse({
        task: { id: taskId, rev }, attempt, runDir: 1, dir,
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
