import { closeSync, fsyncSync, linkSync, lstatSync, openSync, realpathSync,
  statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { startRun } from "../supervisor/run";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { CallAuthority, ExecutorLaunchFile } from "./authority";

const deny = (): never => { throw new CoreError("capability_denied", "detached run owner or source changed"); };

/** Each fixed launch file name has one mode, size bound and session kind; strict settings guard pipe launches. */
const LAUNCH_FILES: Record<ExecutorLaunchFile["name"], { mode: number; bytes: number; interactive: boolean }> = {
  "report-hook.sh": { mode: 0o700, bytes: 16_384, interactive: true },
  "claude-settings.json": { mode: 0o600, bytes: 16_384, interactive: true },
  "strict-claude-settings.json": { mode: 0o600, bytes: 16_384, interactive: false },
  "prompt.md": { mode: 0o600, bytes: 8 * 1024 * 1024, interactive: true },
};

/** Publish a complete fixed artifact without replacing another entry at its name. */
function publishArtifact(dir: string, file: ExecutorLaunchFile): void {
  const temp = join(dir, `.pacer-${randomUUID()}.tmp`), target = join(dir, file.name);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", file.mode);
    const bytes = Buffer.from(file.content, "utf8");
    for (let offset = 0; offset < bytes.length;)
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    // Same-directory link is an atomic no-replace publication. A rename here
    // could overwrite a foreign or crash-left target before the wrapper starts.
    linkSync(temp, target);
  } catch {
    throw new CoreError("capability_denied", "interactive launch artifact changed");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The plugin requests only task identity; the exact process and directory stay host-owned. */
export function answerDetachedRun(authority: CallAuthority, declaredScopes: readonly string[], params: {
  task: { id: string; rev: number }; attempt: number; runDir: 1
}): { pid: number } {
  const grant = authority.consumeDetachedRun(params.task.id, params.task.rev, params.attempt);
  if (!declaredScopes.includes(grant.argv[0]!) || grant.argv[0] === "*") return deny();
  return withTaskLock(authority.ctx, grant.taskId, () => {
    authority.assertActive();
    const task = readTask(authority.ctx, grant.taskId);
    if (!task || task.rev !== grant.rev || task.state !== "running" || task.stopPending || !task.run || task.run.host ||
      !task.executorProvider || task.startIntent?.attempt === grant.attempt ||
      task.run.attempt !== grant.attempt || task.run.dir !== grant.dir || task.run.executor !== task.executor ||
      task.run.session !== grant.session ||
      task.attempts.length + 1 !== grant.attempt ||
      grant.dir !== join(authority.ctx.pacerHome, "runs", grant.taskId, String(grant.attempt))) return deny();
    try {
      const dir = lstatSync(grant.dir), executable = statSync(grant.executable), cwd = statSync(grant.cwd);
      if (!dir.isDirectory() || dir.dev !== grant.dirIdentity.dev || dir.ino !== grant.dirIdentity.ino ||
        (dir.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && dir.uid !== process.getuid()) ||
        realpathSync(grant.dir) !== join(realpathSync(authority.ctx.pacerHome), "runs", grant.taskId, String(grant.attempt)) ||
        !executable.isFile() || !(executable.mode & 0o111) || executable.dev !== grant.executableIdentity.dev ||
        executable.ino !== grant.executableIdentity.ino || executable.size !== grant.executableIdentity.size ||
        executable.mode !== grant.executableIdentity.mode ||
        executable.mtimeMs !== grant.executableIdentity.mtimeMs ||
        realpathSync(grant.executable) !== grant.executable ||
        !cwd.isDirectory() || cwd.dev !== grant.cwdIdentity.dev || cwd.ino !== grant.cwdIdentity.ino ||
        realpathSync(grant.cwd) !== grant.cwd) return deny();
    } catch { return deny(); }
    updateTask(authority.ctx, grant.taskId, current => {
      current.startIntent = { attempt: grant.attempt, providerId: current.executorProvider!, dir: grant.dir };
    });
    const files = grant.files ?? [];
    if (new Set(files.map(file => file.name)).size !== files.length) return deny();
    for (const file of files) {
      const rule = Object.hasOwn(LAUNCH_FILES, file.name) ? LAUNCH_FILES[file.name] : undefined;
      if (!rule || file.mode !== rule.mode || Buffer.byteLength(file.content, "utf8") > rule.bytes ||
        rule.interactive && grant.session !== "interactive") return deny();
    }
    for (const file of files) publishArtifact(grant.dir, file);
    const result = startRun({ dir: grant.dir, argv: [grant.executable, ...grant.argv.slice(1)], cwd: grant.cwd,
      env: { PATH: authority.ctx.env.PATH ?? "/usr/bin:/bin", ...grant.env, HOME: authority.ctx.home },
      stdin: grant.stdin, session: grant.session ?? "pipe",
      ...(grant.umask === undefined ? {} : { umask: grant.umask }),
      ...(grant.keepColor === undefined ? {} : { keepColor: grant.keepColor }) });
    if ("error" in result) throw new CoreError("plugin_unavailable", "detached wrapper launch uncertain; inspect run directory");
    updateTask(authority.ctx, grant.taskId, current => { current.childPid = result.pid; });
    return result;
  });
}
