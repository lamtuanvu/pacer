import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { loadStrategy, MissingStrategyError } from "../config/strategy";
import { CoreError, toCoreError } from "../core/errors";
import { withLock } from "../core/lock";
import type { Ctx } from "../types";
import { listTasksWhere, readTask, taskArchiveDir, taskSettledAt, tasksDir, updateTask, withTaskLockAsync } from "./store";
import { TERMINAL_STATES, type TaskRecord } from "./types";
import { expireDraftAttachments } from "../attachments/store";

async function withRetentionLock<T>(ctx: Ctx, action: () => Promise<T>): Promise<T> {
  try { return await withLock(ctx, "task-retention", action, { timeoutMs: 0, staleMs: 24 * 3600_000 }); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("timed out waiting for")) {
      throw new CoreError("conflict", "task retention is already running", "wait for the active archive or restore operation");
    }
    throw toCoreError(error);
  }
}

export function retentionDays(ctx: Ctx): number {
  try { return loadStrategy(ctx).taskRetentionDays ?? 14; }
  catch (error) { if (error instanceof MissingStrategyError) return 14; throw error; }
}

/** Remote worktrees are conservatively retained: local absence proves nothing. */
export function eligibleForRetention(ctx: Ctx, task: TaskRecord, days: number): boolean {
  if (days <= 0 || task.archived || !TERMINAL_STATES.includes(task.state) || !(task.review || task.dismissed)
    || taskSettledAt(task) >= ctx.now - days * 86400) return false;
  if (task.run?.remoteWorktree) return false;
  const paths = [task.worktree, task.result?.worktree, task.run?.mode === "new" ? task.run.workdir : undefined];
  return !paths.some(path => path && existsSync(path));
}

function artifactName(id: string, name: string): boolean {
  return name.startsWith(`${id}.`) && /\.(log|md|bundle|json)$/.test(name);
}
function pathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function signature(path: string): string {
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile()) throw new CoreError("conflict", `task artifact is not a regular file: ${path}`);
  return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}
async function compress(source: string, destination?: string): Promise<number> {
  let bytes = 0;
  const gzip = createGzip();
  gzip.on("data", chunk => { bytes += chunk.length; });
  const output = destination ? createWriteStream(destination, { flags: "wx", mode: 0o600 })
    : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await pipeline(createReadStream(source), gzip, output);
  return bytes;
}

export interface PruneResult {
  dryRun: boolean;
  tasks: { id: string; archivePath: string; files: string[]; bytes: number; bytesSaved: number }[];
  bytesSaved: number;
  workingSetBytes: number;
}

/** Bounded SQL pages and streaming compression yield between files and tasks. */
export async function pruneTasks(ctx: Ctx, o: { days?: number; dryRun?: boolean } = {}): Promise<PruneResult> {
  const days = o.days ?? retentionDays(ctx);
  const result: PruneResult = { dryRun: !!o.dryRun, tasks: [], bytesSaved: 0, workingSetBytes: 0 };
  if (days === 0) return result;
  if (!Number.isSafeInteger(days) || days < 0) throw new CoreError("invalid_input", "retention days must be non-negative");
  return withRetentionLock(ctx, async () => {
    let before: string | undefined;
    for (;;) {
      const page = listTasksWhere(ctx, { states: TERMINAL_STATES, settledBefore: ctx.now - days * 86400, before, limit: 25 });
      if (!page.length) break;
      for (const task of page) {
        before = task.id;
        if (!eligibleForRetention(ctx, task, days)) continue;
        const names = (await readdir(tasksDir(ctx))).filter(name => artifactName(task.id, name));
        const archive = taskArchiveDir(ctx, task);
        let stage: string | undefined;
        if (!o.dryRun) {
          const parent = join(ctx.pacerHome, "archive", new Date(task.createdAt * 1000).toISOString().slice(0, 7));
          mkdirSync(join(ctx.pacerHome, "archive"), { recursive: true, mode: 0o700 });
          mkdirSync(parent, { recursive: true, mode: 0o700 });
          stage = await mkdtemp(join(parent, ".staging-"));
        }
        try {
          const signatures = new Map<string, string>();
          let bytes = 0, archivedBytes = 0;
          for (const name of names) {
            const source = join(tasksDir(ctx), name);
            signatures.set(name, signature(source));
            const size = (await stat(source)).size;
            bytes += size;
            if (name.endsWith(".log")) archivedBytes += await compress(source, stage ? join(stage, `${name}.gz`) : undefined);
            else {
              archivedBytes += size;
              if (stage) {
                await copyFile(source, join(stage, name));
                // copyFile inherits source mode, so explicitly restrict the copy.
                await chmod(join(stage, name), 0o600);
              }
            }
          }
          const applied = await withTaskLockAsync(ctx, task.id, () => {
            const current = readTask(ctx, task.id);
            if (!current || current.rev !== task.rev || !eligibleForRetention(ctx, current, days)) return false;
            for (const [name, expected] of signatures) {
              if (signature(join(tasksDir(ctx), name)) !== expected) throw new CoreError("conflict", "task artifacts changed during archiving");
            }
            if (o.dryRun) return true;
            if (pathExists(archive)) throw new CoreError("conflict", `archive already exists: ${archive}`, "inspect the retained files before retrying");
            renameSync(stage!, archive);
            stage = undefined;
            // Originals remain until the new record and its compatibility JSON commit.
            // A crash can leave duplicate originals, but cannot lose their contents.
            updateTask(ctx, task.id, t => { t.archived = true; t.archivePath = archive; });
            for (const name of names) rmSync(join(tasksDir(ctx), name));
            return true;
          });
          if (applied) {
            const saved = bytes - archivedBytes;
            result.tasks.push({ id: task.id, archivePath: archive, files: names.map(n => join(tasksDir(ctx), n)), bytes, bytesSaved: saved });
            result.bytesSaved += saved;
            result.workingSetBytes += bytes;
          }
        } finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    return result;
  });
}

export async function restoreTask(ctx: Ctx, id: string): Promise<TaskRecord> {
  return withRetentionLock(ctx, async () => {
    const task = readTask(ctx, id);
    if (!task) throw new CoreError("unknown_task", `unknown task ${id}`);
    if (!task.archived) return task;
    const archive = taskArchiveDir(ctx, task);
    const names = (await readdir(archive)).filter(n => artifactName(id, n.replace(/\.gz$/, "")));
    const stage = await mkdtemp(join(tasksDir(ctx), ".restore-"));
    try {
      const signatures = new Map(names.map(name => [name, signature(join(archive, name))]));
      for (const name of names) {
        if (name === `${id}.json`) continue; // regenerated from the authoritative SQLite record
        const target = join(stage, name.replace(/\.gz$/, ""));
        if (name.endsWith(".log.gz")) await pipeline(createReadStream(join(archive, name)), createGunzip(), createWriteStream(target, { flags: "wx", mode: 0o600 }));
        else {
          await copyFile(join(archive, name), target);
          await chmod(target, 0o600);
        }
      }
      return await withTaskLockAsync(ctx, id, () => {
        if (readTask(ctx, id)?.rev !== task.rev) throw new CoreError("conflict", "task changed during restore");
        for (const [name, expected] of signatures) {
          if (signature(join(archive, name)) !== expected) throw new CoreError("conflict", "archive changed during restore");
        }
        const files = names.filter(n => n !== `${id}.json`).map(n => n.replace(/\.gz$/, ""));
        for (const name of [...files, `${id}.json`]) if (pathExists(join(tasksDir(ctx), name))) throw new CoreError("conflict", `restore destination exists: ${name}`);
        for (const name of files) renameSync(join(stage, name), join(tasksDir(ctx), name));
        const restored = updateTask(ctx, id, t => { delete t.archived; delete t.archivePath; });
        for (const name of names) rmSync(join(archive, name));
        // Preserve unexpected files someone may have added to the archive.
        if (!readdirSync(archive).length) rmdirSync(archive);
        return restored;
      });
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}

/** Timer-independent to make single-flight and daily cadence testable. */
export function retentionScheduler(run: (ctx: Ctx) => Promise<unknown> = async ctx => {
  await expireDraftAttachments(ctx);
  return pruneTasks(ctx);
}) {
  let pending: Promise<void> | undefined, lastRun = -Infinity;
  return {
    tick(ctx: Ctx): Promise<void> {
      if (pending) return pending;
      if (ctx.now - lastRun < 86400) return Promise.resolve();
      lastRun = ctx.now;
      pending = Promise.resolve().then(() => run(ctx)).then(() => {}).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
