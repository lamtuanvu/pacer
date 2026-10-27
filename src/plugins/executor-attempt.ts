import { closeSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CoreError } from "../core/errors";
import { readTask, updateTask, withTaskLock } from "../tasks/store";
import type { RunRef } from "../tasks/types";
import type { Ctx } from "../types";
import { applyExecutorProgress } from "./executor-progress";
import { executorEffectRunResult } from "./executor-protocol";
import { MAX_PROCESS_SPAWN_MS } from "./capability-protocol";
import type { CallResources } from "./authority";
import type { CredentialBinding } from "./credential-bindings";
import { secretReference } from "./http-protocol";
import { killTree } from "../exec/process";
import { realpathSafe } from "../core/git";
import { bindOwnedWorktreeIntent } from "./executor-worktree";
import { NativeWriteError, WRITE_DIRECTORY, writeNative } from "./write-native";

interface ExecutorCaller {
  call(ctx: Ctx, pluginId: string, method: "executor.run", params: unknown,
    options: { onProgress: (event: unknown) => void; resources?: CallResources; deadlineMs?: number;
      spawnAdmission?: (spawn: () => import("node:child_process").ChildProcess) => import("node:child_process").ChildProcess;
      credentialBindings?: readonly CredentialBinding[] }): Promise<unknown>;
}

export interface LocalExecutorEffect { argv: string[]; cwd: string; timeoutMs: number; stdin?: string;
  env?: Record<string, string>; secretEnv?: Record<string, string>; detached?: true }

function ownsRun(ctx: Ctx, taskId: string, owner: RunRef): boolean {
  const task = readTask(ctx, taskId);
  return !!task && task.state === "running" && task.attempts.length + 1 === owner.attempt &&
    task.run?.dir === owner.dir && task.run?.attempt === owner.attempt && !task.run?.host &&
    task.run?.startedAt === owner.startedAt && task.run?.executor === owner.executor;
}

function privateDirectory(path: string, fd: number): void {
  let linked: Stats;
  try { linked = lstatSync(path); }
  catch { throw new CoreError("conflict", "executor run directory is unavailable"); }
  const opened = fstatSync(fd);
  if (!linked.isDirectory() || !opened.isDirectory() || linked.dev !== opened.dev || linked.ino !== opened.ino ||
    (opened.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && opened.uid !== process.getuid()))
    throw new CoreError("conflict", "executor run directory is not private or changed");
}

function claimRunDirectory(ctx: Ctx, taskId: string, attempt: number, recover: boolean):
  { path: string; identity: { dev: number; ino: number } } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId))
    throw new CoreError("invalid_input", "invalid executor task id");
  const native = writeNative();
  let homeFd: number;
  try { homeFd = openSync(ctx.pacerHome, WRITE_DIRECTORY); }
  catch { throw new CoreError("conflict", "executor run home is unavailable"); }
  const opened = [homeFd];
  const runs = join(ctx.pacerHome, "runs");
  const taskDir = join(runs, taskId);
  const attemptDir = join(taskDir, String(attempt));
  try {
    privateDirectory(ctx.pacerHome, homeFd);
    const openChild = (parent: number, name: string, path: string, existing: boolean): number => {
      try { native.mkdirAt(parent, name, 0o700); }
      catch (error) {
        if (!(error instanceof NativeWriteError) || error.errno !== 17)
          throw new CoreError("conflict", "executor run directory could not be created");
        if (!existing) throw new CoreError("conflict", "executor attempt directory already exists");
      }
      let fd: number;
      try { fd = native.openAt(parent, name, WRITE_DIRECTORY); }
      catch { throw new CoreError("conflict", "executor run directory is unavailable"); }
      opened.push(fd);
      privateDirectory(path, fd);
      return fd;
    };
    const runsFd = openChild(homeFd, "runs", runs, true);
    const taskFd = openChild(runsFd, taskId, taskDir, true);
    openChild(taskFd, String(attempt), attemptDir, recover);
    // Resolve every path again after creation; a replaced ancestor cannot become the persisted run owner.
    privateDirectory(ctx.pacerHome, homeFd);
    privateDirectory(runs, runsFd);
    privateDirectory(taskDir, taskFd);
    privateDirectory(attemptDir, opened[opened.length - 1]!);
    if (recover && readdirSync(attemptDir).length !== 0)
      throw new CoreError("conflict", "unpublished executor run directory contains effects");
    privateDirectory(attemptDir, opened[opened.length - 1]!);
    const claimed = fstatSync(opened[opened.length - 1]!);
    return { path: attemptDir, identity: { dev: claimed.dev, ino: claimed.ino } };
  } finally {
    for (const fd of opened.reverse()) closeSync(fd);
  }
}

/** Persist the exact run owner before any provider process effect. */
export async function publishOwnedExecutorRun(ctx: Ctx, pluginId: string, taskId: string,
  executor: string, workdir: string): Promise<{ owner: RunRef; runIdentity: { dev: number; ino: number } }> {
  if (!isAbsolute(workdir)) throw new CoreError("invalid_input", "executor workdir must be absolute");
  let runIdentity: { dev: number; ino: number };
  let isolated = false;
  const owner = withTaskLock(ctx, taskId, (): RunRef => {
    const task = readTask(ctx, taskId);
    if (!task) throw new CoreError("unknown_task", `unknown task ${taskId}`);
    if (task.state !== "running" || task.stopPending || task.run || task.executor !== executor ||
      task.executorProvider !== pluginId)
      throw new CoreError("conflict", "executor task is no longer available for this attempt");
    const attempt = task.attempts.length + 1;
    isolated = realpathSafe(workdir) !== realpathSafe(task.brief.repo);
    if (isolated && (task.executorProvider !== pluginId ||
      task.worktreeIntent?.providerId !== pluginId ||
      task.worktreeIntent?.attempt !== attempt || task.worktreeIntent?.workdir !== workdir))
      throw new CoreError("conflict", "isolated executor run has no bound worktree intent");
    if (!isolated && task.worktreeIntent)
      throw new CoreError("conflict", "in-place run conflicts with pending worktree intent");
    const dir = join(ctx.pacerHome, "runs", taskId, String(attempt));
    const expected = { attempt, providerId: pluginId, executor, workdir, dir };
    const recover = task.runClaim !== undefined;
    if (recover && JSON.stringify(task.runClaim) !== JSON.stringify(expected))
      throw new CoreError("conflict", "executor run claim changed before dispatch");
    if (!recover) {
      try { lstatSync(dir); throw new CoreError("conflict", "executor attempt directory already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      updateTask(ctx, taskId, current => { current.runClaim = expected; });
    }
    const claim = claimRunDirectory(ctx, taskId, attempt, recover);
    if (claim.path !== dir) throw new CoreError("conflict", "executor run directory changed");
    runIdentity = claim.identity;
    const run: RunRef = { dir, attempt, executor, startedAt: Date.now() / 1000,
      mode: isolated ? "new" : "current", workdir, logFile: join(dir, "stdout") };
    updateTask(ctx, taskId, current => {
      if (JSON.stringify(current.runClaim) !== JSON.stringify(expected))
        throw new CoreError("conflict", "executor run claim changed before publication");
      current.run = run;
      delete current.runClaim;
      if (isolated) current.worktree = workdir;
    });
    return run;
  });
  if (isolated) await bindOwnedWorktreeIntent(ctx, taskId, pluginId, owner.attempt);
  return { owner, runIdentity: runIdentity! };
}

/** Stage an owned local attempt. Production dispatch stays on the existing backend until full effects and recovery are reviewed. */
export async function runOwnedExecutorAttempt(ctx: Ctx, caller: ExecutorCaller, pluginId: string,
  taskId: string, executor: string, workdir: string,
  effect?: LocalExecutorEffect, credentialBindings: readonly CredentialBinding[] = []): Promise<ReturnType<typeof executorEffectRunResult.parse>> {
  if (effect && (!isAbsolute(effect.cwd) || effect.cwd !== workdir || effect.argv.length < 1 ||
    effect.argv.length > 32 || effect.argv.some(value => !value || value.length > 4096 || value.includes("\0")) ||
    !Number.isSafeInteger(effect.timeoutMs) || effect.timeoutMs < 1 || effect.timeoutMs > MAX_PROCESS_SPAWN_MS ||
    (effect.stdin !== undefined && (typeof effect.stdin !== "string" || Buffer.byteLength(effect.stdin, "utf8") > 262144)) ||
    Object.entries(effect.env ?? {}).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name.startsWith("PACER_KEY_") ||
      typeof value !== "string" || value.includes("\0")) ||
    Object.entries(effect.secretEnv ?? {}).some(([name, ref]) => !/^PACER_KEY_[A-Z0-9_]+$/.test(name) ||
      Object.hasOwn(effect.env ?? {}, name) || !secretReference.safeParse(ref).success)))
    throw new CoreError("invalid_input", "invalid executor effect");
  const refs = new Set(Object.values(effect?.secretEnv ?? {}));
  if (credentialBindings.some(binding => !refs.has(binding.ref) || typeof binding.resolve !== "function") ||
    new Set(credentialBindings.map(binding => binding.ref)).size !== credentialBindings.length ||
    credentialBindings.length !== refs.size)
    throw new CoreError("invalid_input", "executor credential binding is not issued for this effect");
  if (effect?.detached && refs.size) throw new CoreError("invalid_input", "detached secret-bearing output suppression is not available");
  const detachedPin = effect?.detached ? (() => {
    const selected = ctx.which(effect.argv[0]!);
    if (!selected || !isAbsolute(selected)) throw new CoreError("invalid_input", "detached executor executable is unavailable");
    try {
      const executable = realpathSync(selected), binary = statSync(executable), cwd = realpathSync(effect.cwd), directory = statSync(cwd);
      if (!binary.isFile() || !(binary.mode & 0o111) || !directory.isDirectory()) throw Error();
      return { executable, executableIdentity: { dev: binary.dev, ino: binary.ino, size: binary.size, mtimeMs: binary.mtimeMs,
        mode: binary.mode },
        cwd, cwdIdentity: { dev: directory.dev, ino: directory.ino } };
    } catch { throw new CoreError("invalid_input", "detached executor source is unavailable"); }
  })() : undefined;
  const sensitiveOutput = refs.size > 0;
  const { owner, runIdentity } = await publishOwnedExecutorRun(ctx, pluginId, taskId, executor, workdir);
  const revision = withTaskLock(ctx, taskId, () => {
    if (!ownsRun(ctx, taskId, owner))
      throw new CoreError("conflict", "executor attempt changed before dispatch");
    return readTask(ctx, taskId)!.rev;
  });
  let spawnedPid: number | undefined;
  const spawnAdmission = (spawn: () => import("node:child_process").ChildProcess) =>
    withTaskLock(ctx, taskId, () => {
      if (!ownsRun(ctx, taskId, owner) || readTask(ctx, taskId)?.stopPending)
        throw new CoreError("conflict", "executor attempt changed before process spawn");
      const child = spawn();
      try {
        if (!child.pid) throw new CoreError("plugin_unavailable", "executor process has no pid");
        updateTask(ctx, taskId, task => { task.childPid = child.pid; });
        spawnedPid = child.pid;
        return child;
      } catch (error) {
        if (child.pid) killTree(child.pid, "SIGTERM");
        throw error;
      }
    });
  let raw: unknown;
  try { raw = await caller.call(ctx, pluginId, "executor.run",
    { task: { id: taskId, rev: revision }, attempt: owner.attempt, runDir: 1, ...(effect ? { effect: {
      argv: effect.argv, cwd: effect.cwd, timeoutMs: effect.timeoutMs,
      ...(effect.stdin === undefined ? {} : { stdin: effect.stdin }),
      ...(effect.env === undefined ? {} : { env: effect.env }),
      ...(effect.secretEnv === undefined ? {} : { secretEnv: effect.secretEnv }),
      ...(effect.detached ? { detached: true as const } : {}),
    } } : {}) },
    { onProgress: event => applyExecutorProgress(ctx, taskId, owner.attempt, event, owner),
      ...(effect ? { deadlineMs: effect.detached ? 15_000 : effect.timeoutMs + 5000,
        ...(effect.detached ? {} : { spawnAdmission }),
        credentialBindings,
        resources: { reads: [], stores: [], ...(detachedPin ? { detachedRun: {
          taskId, rev: revision, attempt: owner.attempt, dir: owner.dir, dirIdentity: runIdentity!,
          argv: effect.argv, cwd: detachedPin.cwd, executable: detachedPin.executable,
          executableIdentity: detachedPin.executableIdentity, cwdIdentity: detachedPin.cwdIdentity,
          env: effect.env ?? {}, ...(effect.stdin === undefined ? {} : { stdin: effect.stdin }),
        } } : {}), writes: (effect.detached || sensitiveOutput ? [] : ["stdout", "stderr"]).map(name => ({
          path: join(owner.dir, name), root: owner.dir, rootIdentity: runIdentity,
          kind: "file" as const, operations: ["write" as const],
        })), commands: effect.detached ? [] : [{ argv: effect.argv, cwd: effect.cwd,
          env: effect.env ?? {}, secretEnv: effect.secretEnv ?? {}, timeoutMs: effect.timeoutMs,
          ...(sensitiveOutput ? { suppressOutput: true } : {
            capture: { stdout: join(owner.dir, "stdout"), stderr: join(owner.dir, "stderr") } }),
          ...(effect.stdin === undefined ? {} : { stdin: effect.stdin }) }] } } : {}) });
  } finally {
    if (spawnedPid) withTaskLock(ctx, taskId, () => {
      const current = readTask(ctx, taskId);
      if (current?.childPid === spawnedPid) updateTask(ctx, taskId, task => { delete task.childPid; });
    });
  }
  const result = executorEffectRunResult.safeParse(raw);
  if (!result.success) throw new CoreError("plugin_refused", "executor returned an invalid result");
  withTaskLock(ctx, taskId, () => {
    if (!ownsRun(ctx, taskId, owner))
      throw new CoreError("conflict", "executor attempt changed before completion");
  });
  return result.data;
}
