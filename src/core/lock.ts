import { CoreError } from './errors';
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";

/** Lock files stay in <pacerHome>/orca/ so pacer versions from before the core move still see them. */
const lockDir = (ctx: Ctx) => join(ctx.pacerHome, "orca");

/** A cross-process lock file. Stale locks (older than staleMs) are taken over. */
export async function withLock<T>(
  ctx: Ctx, name: string, fn: () => Promise<T>, o: { timeoutMs?: number; staleMs?: number } = {},
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
    return await fn();
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
      if (Date.now() >= deadline) {if(o.conflict)throw new CoreError('conflict','Workspace admission is busy; refresh and retry');throw new Error(`timed out waiting for ${file}`);}
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  try { return fn(); }
  finally { rmSync(file, { force: true }); }
}
