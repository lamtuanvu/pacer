import { mkdir, readFile, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ctx } from "../types";

export interface Cursor<T> {
  size: number;
  mtime: number;
  inode: number;
  offset: number;
  aggregate: T;
  retainedSince?: number;
}

/** Serialize updates within a process; atomic snapshots are safe across processes.
 * A lost cache update only causes a subsequent reader to do extra work.
 */
export class CursorStore<T> {
  private files: Record<string, Cursor<T>> | undefined;
  private dirty = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private path: string, private validAggregate: (value: unknown) => boolean, private version = 1) {}

  run<R>(ctx: Ctx, action: (files: Record<string, Cursor<T>>) => Promise<R>): Promise<R> {
    const next = this.pending.then(async () => {
      if (!this.files) {
        try {
          const data = JSON.parse(await readFile(this.path, "utf8"));
          this.files = {};
          if (data?.version === this.version && data.files && typeof data.files === "object" && !Array.isArray(data.files)) {
            for (const [path, value] of Object.entries(data.files)) {
              const cursor = value as Cursor<T> | null;
              if (cursor && reusable(cursor, { size: cursor.size, mtimeMs: cursor.mtime, ino: cursor.inode })
                && this.validAggregate(cursor.aggregate)) this.files[path] = cursor;
            }
          }
        } catch { this.files = {}; } // Missing/corrupt cache is rebuilt from source logs.
      }
      const tracked = new Proxy(this.files!, {
        set: (files, path: string, value: Cursor<T>) => {
          if (files[path] !== value) this.dirty = true;
          files[path] = value;
          return true;
        },
        deleteProperty: (files, path: string) => {
          if (Object.hasOwn(files, path)) this.dirty = true;
          delete files[path];
          return true;
        },
      });
      const result = await action(tracked);
      if (!ctx.readOnly && this.dirty) {
        const dir = join(ctx.pacerHome, "state");
        const tmp = `${this.path}.${randomUUID()}.tmp`;
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const file = await open(tmp, "wx", 0o600);
          try { await file.writeFile(JSON.stringify({ version: this.version, files: this.files })); }
          finally { await file.close(); }
          await rename(tmp, this.path);
          this.dirty = false;
        } catch (error) {
          await unlink(tmp).catch(() => {});
          // Cache persistence must never discard a successfully read usage result.
          if (ctx.env.PACER_TRACE_STATUS === "1") console.error("[pacer:status:debug] cursor persistence failed", (error as NodeJS.ErrnoException).code);
        }
      }
      return result;
    });
    this.pending = next.catch(() => {});
    return next;
  }
}

export function reusable<T>(cursor: Cursor<T> | undefined, s: { size: number; mtimeMs: number; ino: number }): cursor is Cursor<T> {
  return !!cursor && Number.isFinite(cursor.offset) && cursor.offset >= 0 && cursor.offset <= cursor.size
    && Number.isFinite(cursor.size) && Number.isFinite(cursor.mtime) && cursor.inode === s.ino && cursor.size <= s.size
    && (cursor.size !== s.size || cursor.mtime === s.mtimeMs);
}
