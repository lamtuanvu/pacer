import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { readRun } from "../supervisor/run";
import { readTask } from "../tasks/store";
import { inspectOwnedExecutorRun } from "./executor-run-state";
import type { CallAuthority } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "executor run observation owner changed"); };

function owned(authority: CallAuthority, taskId: string, attempt: number) {
  authority.assertActive();
  const grant = authority.observedRun(taskId, attempt), task = readTask(authority.ctx, taskId);
  if (!task || task.state !== "running" || task.executorProvider !== grant.providerId ||
    task.executor !== grant.executor || task.attempts.length + 1 !== attempt ||
    !task.run || task.run.dir !== grant.dir || task.run.attempt !== attempt ||
    task.run.startedAt !== grant.startedAt || task.run.workdir !== grant.workdir || task.run.host ||
    (task.startIntent?.attempt === attempt &&
      (task.startIntent.providerId !== task.executorProvider || task.startIntent.dir !== grant.dir))) return deny();
  try {
    const dir = lstatSync(grant.dir);
    if (!dir.isDirectory() || dir.dev !== grant.dirIdentity.dev || dir.ino !== grant.dirIdentity.ino) return deny();
  } catch { return deny(); }
  return { task, grant };
}

/** Repeatable read on one claim; every poll revalidates the immutable run fingerprint. */
export function answerExecutorPoll(authority: CallAuthority, params: { taskId: string; attempt: number }) {
  const before = owned(authority, params.taskId, params.attempt);
  const observed = readRun(before.grant.dir);
  const after = owned(authority, params.taskId, params.attempt);
  const durable = inspectOwnedExecutorRun(authority.ctx, params.taskId, params.attempt);
  if (after.grant !== before.grant || durable.dir !== before.grant.dir ||
    after.task.run?.startedAt !== before.task.run?.startedAt) return deny();
  const report = observed.report && observed.report.summary.length <= 65_536
    ? { status: observed.report.status, summary: observed.report.summary, at: observed.report.at } : null;
  authority.assertActive();
  return { state: durable.state, pid: durable.pid, exitCode: durable.exitCode,
    startedAt: durable.startedAt, stdoutBytes: durable.stdoutBytes,
    stderrBytes: durable.stderrBytes, lastOutputAt: observed.lastOutputAt,
    interactive: observed.interactive ?? false, stopPending: !!after.task.stopPending,
    report };
}

/** Final bounded output is read only after the exact wrapper has a recorded exit. */
export function answerExecutorOutput(authority: CallAuthority, params: { taskId: string; attempt: number }) {
  const before = owned(authority, params.taskId, params.attempt);
  const observed = inspectOwnedExecutorRun(authority.ctx, params.taskId, params.attempt);
  if (observed.state !== "exited") return deny();
  const tail = (name: "stdout" | "stderr") => {
    let fd: number;
    try { fd = openSync(join(before.grant.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
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
  const after = owned(authority, params.taskId, params.attempt);
  const current = inspectOwnedExecutorRun(authority.ctx, params.taskId, params.attempt);
  if (after.grant !== before.grant || after.task.run?.startedAt !== before.task.run?.startedAt ||
    current.state !== "exited" || current.exitCode !== observed.exitCode ||
    current.stdoutBytes !== observed.stdoutBytes || current.stderrBytes !== observed.stderrBytes)
    return deny();
  authority.assertActive();
  return { stdoutBase64, stderrBase64 };
}
