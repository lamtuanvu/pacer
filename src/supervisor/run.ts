import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "../exec/process";
import { WRAPPER_SH } from "./wrapper";

export interface RunSpec { dir: string; argv: string[]; cwd: string; env: Record<string, string | undefined>; stdin?: string }
export interface RunState { pid: number | null; startedAt: number | null; exit: number | null; alive: boolean; stdoutBytes: number; stderrBytes: number; lastOutputAt: number | null }

const num = (file: string): number | null => {
  try { const v = Number(readFileSync(file, "utf8").trim()); return Number.isFinite(v) && readFileSync(file, "utf8").trim() !== "" ? v : null; } catch { return null; }
};

/** Starts the wrapper detached (own session). The pid file is written here too, so readers never race the wrapper. */
export function startRun(spec: RunSpec): { pid: number } | { error: string } {
  try {
    mkdirSync(spec.dir, { recursive: true });
    // A reused directory must not hand a stale exit or output to the new run.
    for (const f of ["pid", "pid.tmp", "child", "started", "exit", "exit.tmp", "stdout", "stderr", "stdin"]) rmSync(join(spec.dir, f), { force: true });
    const script = join(spec.dir, "run.sh");
    writeFileSync(script, WRAPPER_SH, { mode: 0o700 });
    if (spec.stdin !== undefined) writeFileSync(join(spec.dir, "stdin"), spec.stdin, { mode: 0o600 });
    const proc = Bun.spawn(["/bin/sh", script, spec.dir, ...spec.argv], {
      detached: true, cwd: spec.cwd, env: spec.env, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    proc.unref();
    writeFileSync(join(spec.dir, "pid"), String(proc.pid));
    return { pid: proc.pid };
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/** True only when `pid` is alive AND its command line is this run's wrapper (guards against pid reuse). */
function wrapperAlive(pid: number, dir: string): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  return ps.exitCode === 0 && ps.stdout.toString().includes(join(dir, "run.sh"));
}

const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
const mtime = (f: string) => { try { return statSync(f).mtimeMs / 1000; } catch { return null; } };

export function readRun(dir: string): RunState {
  const pid = num(join(dir, "pid")), exit = num(join(dir, "exit"));
  const out = join(dir, "stdout"), err = join(dir, "stderr");
  const stdoutBytes = size(out), stderrBytes = size(err);
  const times = [stdoutBytes ? mtime(out) : null, stderrBytes ? mtime(err) : null].filter((t): t is number => t !== null);
  return {
    pid, startedAt: num(join(dir, "started")), exit, stdoutBytes, stderrBytes,
    lastOutputAt: times.length ? Math.max(...times) : null,
    alive: exit === null && pid !== null && wrapperAlive(pid, dir),
  };
}

/** TERM the run's process group, then KILL after graceMs. Returns the recorded exit, or 137 when it had to be killed. */
export async function stopRun(dir: string, o: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ code: number; killed: boolean }> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const s = readRun(dir);
  if (s.exit !== null) return { code: s.exit, killed: false };
  if (s.pid === null || !s.alive) return { code: s.exit ?? 137, killed: false };
  const end = Date.now() + (o.graceMs ?? 5000);
  // The parent publishes pid before the wrapper installs its traps and starts the child.
  // Wait for child readiness so an immediate stop can record a graceful TERM exit.
  while (!existsSync(join(dir, "child")) && Date.now() < end) {
    const now = readRun(dir);
    if (now.exit !== null) return { code: now.exit, killed: false };
    if (!now.alive) break;
    await sleep(50);
  }
  killTree(s.pid, "SIGTERM");
  while (Date.now() < end) {
    const now = readRun(dir);
    if (now.exit !== null) return { code: now.exit, killed: false };
    if (!now.alive) break;
    await sleep(50);
  }
  killTree(s.pid, "SIGKILL");
  await sleep(100);
  const after = readRun(dir);
  if (after.exit !== null) return { code: after.exit, killed: false };
  writeFileSync(join(dir, "exit"), "137");
  return { code: 137, killed: true };
}

function tailFile(file: string, maxBytes: number): string {
  if (!existsSync(file)) return "";
  const n = size(file), start = Math.max(0, n - maxBytes), buf = Buffer.alloc(n - start);
  const fd = openSync(file, "r");
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  return buf.toString("utf8");
}

export function readOutput(dir: string, maxBytes = 256 * 1024): { stdout: string; stderr: string } {
  return { stdout: tailFile(join(dir, "stdout"), maxBytes), stderr: tailFile(join(dir, "stderr"), maxBytes) };
}
