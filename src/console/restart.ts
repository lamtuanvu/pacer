import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { readJson } from "../fsutil";
import { consolePath, consolesDir } from "../link/paths";
import { parseSnapshot } from "../link/envelope";
import { pidAlive } from "../link/store";

export function binaryStamp(path: string): string | null {
  try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; }
}
export function binaryChanged(path: string, stamp: string | null): boolean {
  const current = binaryStamp(path); return stamp !== null && current !== null && current !== stamp;
}
/** Signal registrations only; unregistered old processes have no reliable identity to signal. */
export async function restartConsoles(ctx: Ctx, alive: (pid: number) => boolean = pidAlive): Promise<number> {
  const dir = consolesDir(ctx);
  const paths = [consolePath(ctx), ...(existsSync(dir) ? readdirSync(dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)).map(f => join(dir, f)) : [])];
  const pids = new Set<number>();
  for (const path of paths) {
    const c = parseSnapshot({ v: 1, seq: 0, at: 0, console: readJson(path) })?.console;
    // SIGUSR1 restart support starts in 0.1.8; unknown/older processes could terminate on this signal.
    if (!c || !c.version || !supportsRestart(c.version) || !Number.isInteger(c.pid) || c.pid <= 1 || c.pid === process.pid || ctx.now - c.heartbeatAt > 600 || !alive(c.pid)) continue;
    pids.add(c.pid);
  }
  let count = 0;
  for (const pid of pids) {
    try { if ((await ctx.run(["kill", "-USR1", String(pid)], 5000)).code === 0) count++; } catch { /* A console may exit between discovery and signal. */ }
  }
  return count;
}
function supportsRestart(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > 0 || Number(m[2]) > 1 || Number(m[2]) === 1 && Number(m[3]) >= 8);
}
