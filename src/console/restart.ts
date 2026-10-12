import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../types";
import { readJson } from "../fsutil";
import { consolePath, consolesDir } from "../link/paths";
import { pacerArgv } from "../install/self";
import { LIMITS, parseSnapshot } from "../link/envelope";
import { pidAlive } from "../link/store";

export function binaryStamp(path: string): string | null {
  try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; }
}
export function binaryChanged(path: string, stamp: string | null): boolean {
  const current = binaryStamp(path); return stamp !== null && current !== null && current !== stamp;
}
/** Signal registrations only; unregistered old processes have no reliable identity to signal. */
export async function restartConsoles(ctx: Ctx, alive: (pid: number) => boolean = pidAlive, report: (message: string) => void = message => process.stderr.write(`pacer: ${message}\n`)): Promise<number> {
  const dir = consolesDir(ctx);
  const paths = [consolePath(ctx), ...(existsSync(dir) ? readdirSync(dir).filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f)).map(f => join(dir, f)) : [])];
  const pids = new Set<number>();
  for (const path of paths) {
    const c = parseSnapshot({ v: 1, seq: 0, at: 0, console: readJson(path) })?.console;
    // SIGUSR1 restart support starts in 0.1.8; unknown/older processes could terminate on this signal.
    if (!c || !c.version || !supportsRestart(c.version) || !Number.isInteger(c.pid) || c.pid <= 1 || c.pid === process.pid || !alive(c.pid)) continue;
    if (ctx.now - c.heartbeatAt > LIMITS.heartbeatS) { report(`skipped console pid ${c.pid}: heartbeat is stale`); continue; }
    pids.add(c.pid);
  }
  let count = 0;
  for (const pid of pids) {
    try {
      const ps = await ctx.run(["ps", "-o", "command=", "-p", String(pid)], 5000);
      const word = (value: string) => new RegExp(`(?:^|[\\s"'])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s"'])`).test(ps.stdout);
      if (ps.code !== 0 || !pacerArgv(ctx.env).every(word) || !word("console")) { report(`skipped console pid ${pid}: process identity could not be verified`); continue; }
      if ((await ctx.run(["kill", "-USR1", String(pid)], 5000)).code === 0) count++;
      else report(`skipped console pid ${pid}: signal failed`);
    } catch { report(`skipped console pid ${pid}: process exited or inspection failed`); }
  }
  return count;
}
function supportsRestart(version: string): boolean {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > 0 || Number(m[2]) > 1 || Number(m[2]) === 1 && Number(m[3]) >= 8);
}

/** Coalesce update requests until the console finishes its current command or prompt. */
export function consoleRestarter(deps: { idle(): boolean; unregister(): void; register(): void; exec(): void; report(message: string): void }) {
  let pending = false, executing = false;
  const retry = () => {
    if (!pending || executing || !deps.idle()) return;
    pending = false; executing = true;
    deps.report("pacer was updated; restarting console");
    try { deps.unregister(); deps.exec(); }
    catch (e) {
      // execve failed: keep this same process visible immediately, rather than waiting for a heartbeat.
      try { deps.register(); } finally { deps.report(`pacer: could not restart console: ${(e as Error).message}`); }
    } finally { executing = false; }
  };
  return { request: () => { pending = true; retry(); }, retry };
}
