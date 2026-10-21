import { Database } from "bun:sqlite";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Ctx } from "../../types";
import { CoreError } from "../../core/errors";

const held = new Set<string>();

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
function privateEntry(path: string, directory = false): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new CoreError("not_allowed", "Desktop coordination state must be private and owned by the service user");
  }
}

/**
 * Short synchronous transactions only. SQLite owns the stable inode's kernel
 * lock; there is no time-based expiry, lockfile unlink, or application lock
 * takeover. Full synchronous rollback journaling survives process death.
 * Acquire logical work authorization before entity locks. This physical lock is
 * released before entity operations; its callbacks must NEVER await, start work,
 * or acquire an entity lock. Entity-locked code may validate/update an already
 * admitted lease in a short transaction, so no reverse lock dependency exists.
 * Installation orchestration must likewise release this lock before native I/O.
 */
export function withDesktopCoordinator<T>(ctx: Ctx, action: (db: Database) => T): T {
  if (ctx.readOnly) throw new CoreError("not_allowed", "Desktop coordination state is read-only");
  const key = resolve(ctx.pacerHome);
  if (held.has(key)) throw new CoreError("conflict", "Nested desktop coordination transaction");
  held.add(key);
  let db: Database | undefined;
  try {
    mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
    const dir = join(ctx.pacerHome, "desktop-updates");
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error; }
    privateEntry(dir, true);
    for (const parent of [ctx.pacerHome, dirname(ctx.pacerHome)]) {
      const fd = openSync(parent, constants.O_RDONLY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const path = join(dir, "admission.sqlite");
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(dir, constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    privateEntry(path);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { privateEntry(path + suffix); } catch (error) { if (!missing(error)) throw error; }
    }
    db = new Database(path, { create: false, strict: true });
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action(db);
      if (result instanceof Promise) throw new CoreError("invalid_input", "Desktop coordination callback must be synchronous");
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("conflict", "Desktop coordination is unavailable", "Retry after active coordination finishes; retain recovery state if this persists.");
  } finally { try { db?.close(); } finally { held.delete(key); } }
}
