import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/** Lock files stay in <pacerHome>/orca/ so pacer versions from before the core move still see them. */
const lockDir = (ctx: Ctx) => join(ctx.pacerHome, "orca");
function lockPath(ctx: Ctx, name: string): string {
  const dir = lockDir(ctx);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("lock directory is a symlink");
  chmodSync(dir, 0o700);
  return join(dir, `${name}.lock`);
}

/** A cross-process lock file. Stale locks (older than staleMs) are taken over. */
export async function withLock<T>(
  ctx: Ctx, name: string, fn: () => Promise<T>, o: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("invalid lock name");
  const file = lockPath(ctx, name);
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  const staleMs = o.staleMs ?? 120_000;
  for (;;) {
    try {
      closeSync(openSync(file, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) {
          rmSync(file, { force: true });
          continue;
        }
      } catch {
        continue; // released between our open and stat
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
      await Bun.sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(file, { force: true });
  }
}

/** Synchronous counterpart for store callers; shares lock files with withLock. */
export function withLockSync<T>(
  ctx: Ctx, name: string, fn: () => T, o: { timeoutMs?: number; staleMs?: number } = {},
): T {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("invalid lock name");
  const file = lockPath(ctx, name);
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  const staleMs = o.staleMs ?? 120_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { closeSync(openSync(file, "wx", 0o600)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) { rmSync(file, { force: true }); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  try { return fn(); }
  finally { rmSync(file, { force: true }); }
}
