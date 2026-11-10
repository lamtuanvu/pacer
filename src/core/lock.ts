import { CoreError } from './errors';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/** Lock files stay in <pacerHome>/orca/ so pacer versions from before the core move still see them. */
const lockDir = (ctx: Ctx) => join(ctx.pacerHome, "orca");

/** Lock files held by a withLock caller that is currently suspended at an await in this
 * process. A withLockSync waiter must never spin for these: the holder can only resume on
 * this event loop, and Atomics.wait would block the loop and deadlock both callers. */
const suspendedHolders = new Map<string, number>();

/** A cross-process lock file. Stale locks (older than staleMs) are taken over. */
export async function withLock<T>(
  ctx: Ctx, name: string, fn: () => Promise<T> | T, o: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("invalid lock name");
  mkdirSync(lockDir(ctx), { recursive: true });
  const file = join(lockDir(ctx), `${name}.lock`);
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  const staleMs = o.staleMs ?? 120_000;
  for (;;) {
    try {
      closeSync(openSync(file, "wx"));
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
    const result = fn();
    // Do not retain a completed synchronous transaction until a microtask runs:
    // another synchronous caller can block that microtask waiting for this lock.
    if (result && typeof (result as Promise<T>).then === "function") {
      // The holder is about to suspend at an await while holding the file. Record it so a
      // synchronous waiter in this process refuses instead of spinning: blocking this
      // event loop would stop the holder from ever resuming to release.
      suspendedHolders.set(file, (suspendedHolders.get(file) ?? 0) + 1);
      try {
        return await result;
      } finally {
        const remaining = (suspendedHolders.get(file) ?? 1) - 1;
        if (remaining > 0) suspendedHolders.set(file, remaining);
        else suspendedHolders.delete(file);
      }
    }
    return result;
  } finally {
    rmSync(file, { force: true });
  }
}

/** Synchronous counterpart for store callers; shares lock files with withLock. */
export function withLockSync<T>(
  ctx: Ctx, name: string, fn: () => T, o: { timeoutMs?: number; staleMs?: number; conflict?: boolean } = {},
): T {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) throw new Error("invalid lock name");
  mkdirSync(lockDir(ctx), { recursive: true });
  const file = join(lockDir(ctx), `${name}.lock`);
  const deadline = Date.now() + (o.timeoutMs ?? 20_000);
  const staleMs = o.staleMs ?? 120_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { closeSync(openSync(file, "wx")); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(file).mtimeMs > staleMs) { rmSync(file, { force: true }); continue; }
      } catch { continue; }
      if (suspendedHolders.has(file)) {
        // A withLock caller in this process is suspended at an await holding this file.
        // Spinning would block the event loop it needs to resume on, so a synchronous
        // wait can never succeed; refuse instead of deadlocking until the deadline.
        if (o.conflict) throw new CoreError('conflict','Workspace admission is busy; refresh and retry');
        throw new Error(`cannot wait synchronously for ${file} while an async holder in this process is suspended`);
      }
      if (Date.now() >= deadline) {if(o.conflict)throw new CoreError('conflict','Workspace admission is busy; refresh and retry');throw new Error(`timed out waiting for ${file}`);}
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  try { return fn(); }
  finally { rmSync(file, { force: true }); }
}
