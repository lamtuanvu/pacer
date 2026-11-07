import { beginWorkSync, attachRunEvidenceSync, finishWorkSync } from "../update/desktop/admission";
import { randomBytes, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { readReport, type SessionReport } from "../session/reports";
import { readSessionVersion } from "../session/protocol";
import type { RunIO } from "./io";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { killTree } from "../exec/process";
import type { ProcessIdentity } from "../update/desktop/process-identity";
import { withUmask } from "../exec/login-env";
import { WRAPPER_SH } from "./wrapper";
import { makeCtx } from "../ctx";
import { loadStrategy } from "../config/strategy";
import { validateExecution } from "../config/execution";
import { fileURLToPath } from "node:url";
import { pruneSessions } from "../session/retention";
import type { InteractionMode } from "../tasks/types";
import { stat } from "node:fs/promises";

export interface RunSpec { interactionMode?: InteractionMode; takeover?: boolean; dir: string; argv: string[]; cwd: string; env: Record<string, string | undefined>; stdin?: string; session?: "pty" | "pipe" | "interactive"; sessionLogMb?: number;
  /** The login shell's umask for the agent only (validated octal); absent keeps the service's. */
  umask?: string;
  /** Color flags the user's profile set, kept in an interactive PTY. */
  keepColor?: string[] }
/**
 * `sessionMinor`: the session-socket protocol minor of an interactive run's host, from session.version. A 1.2 host has no
 * controller, so supervision uses `lastInputAt` instead (ADR 0023); absent means a 1.1 host or none.
 */
export interface RunState { lastInputAt?: number | null; controller?: string | null; sessionMinor?: number; interactive?: boolean; report?: SessionReport | null; pid: number | null; startedAt: number | null; exit: number | null; alive: boolean; stdoutBytes: number; stderrBytes: number; lastOutputAt: number | null }

const num = (file: string): number | null => {
  try { const v = Number(readFileSync(file, "utf8").trim()); return Number.isFinite(v) && readFileSync(file, "utf8").trim() !== "" ? v : null; } catch { return null; }
};

const livenessCache = new Map<string, { alive: boolean; exit: number | null; timestamp: number }>();
const LIVENESS_TTL_MS = 5000;

function getCachedLiveness(dir: string): { alive: boolean; exit: number | null } | null {
  const cached = livenessCache.get(dir);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > LIVENESS_TTL_MS) {
    livenessCache.delete(dir);
    return null;
  }
  return { alive: cached.alive, exit: cached.exit };
}

function setCachedLiveness(dir: string, alive: boolean, exit: number | null): void {
  livenessCache.set(dir, { alive, exit, timestamp: Date.now() });
}

/** Starts the wrapper detached (own session). The pid file is written here too, so readers never race the wrapper. */
export function startRun(spec: RunSpec): { pid: number } | { error: string } {
  const taskRun=basename(dirname(dirname(spec.dir)))==="runs";
  const ctx=makeCtx({env:spec.env,...(taskRun?{pacerHome:dirname(dirname(dirname(spec.dir)))}:{})});
  let lease: string | undefined, attempted = false;
  try {
    lease = beginWorkSync(ctx, { kind: "session", id: createHash("sha256").update(spec.dir).digest("hex"), label: "Executor session" });
    mkdirSync(spec.dir, { recursive: true });
    // A reused directory must not hand a stale exit or output to the new run.
    for (const f of ["pid", "pid.tmp", "child", "started", "exit", "exit.tmp", "stdout", "stderr", "stdin", "session.log", "session.log.1", "session.ckpt", "session.ckpt.tmp", "session.sock", "session.sock.path", "session.host", "session.version", "session.json", "session.activity", "session.input", "session.ended", "session.state", "session.state.tmp", "interactive.json", "report.json", "completion.json", "session-status.json", "events.jsonl", "transcript-report.md"]) rmSync(join(spec.dir, f), { force: true });
    const script = join(spec.dir, "run.sh");
    writeFileSync(script, WRAPPER_SH, { mode: 0o700 });
    if (spec.stdin !== undefined) writeFileSync(join(spec.dir, "stdin"), spec.stdin, { mode: 0o600 });
    let execution;
    try { execution=validateExecution(loadStrategy(ctx).execution); } catch { /* absent strategy keeps pipe default */ }
    const interactive = spec.session === "interactive";
    const reportToken = interactive ? randomBytes(32).toString("hex") : undefined;
    if (interactive) writeFileSync(join(spec.dir, "interactive.json"), JSON.stringify({reportToken, interactionMode: spec.interactionMode}), {mode: 0o600});
    const pty=interactive || (spec.session ?? execution?.session)==="pty";
    const argv=withUmask(spec.argv, spec.umask);
    let command=["/bin/sh", script, spec.dir, ...argv];
    if(pty) {
      chmodSync(spec.dir,0o700); if(taskRun) chmodSync(dirname(spec.dir),0o700);
      writeFileSync(join(spec.dir,"session.json"),JSON.stringify({interactive,interactionMode:spec.interactionMode,takeover:spec.takeover,argv,cwd:spec.cwd,...(spec.keepColor?.length?{keepColor:spec.keepColor}:{}),pacerHome:ctx.pacerHome,capBytes:(spec.sessionLogMb ?? execution?.sessionLogMb ?? 8)*1024*1024}),{mode:0o600});
      // Bun source runs and compiled binaries both re-enter through the CLI.
      command=/(^|\/)bun(?:\.exe)?$/.test(process.execPath)
        ? [process.execPath,fileURLToPath(new URL("../cli.ts",import.meta.url)),"_session",spec.dir]
        : [process.execPath,"_session",spec.dir];
      pruneSessions(ctx,execution?.sessionRetentionDays ?? 14);
    }
    attachRunEvidenceSync(ctx, lease, spec.dir);
    writeFileSync(join(spec.dir, "admission.json"), JSON.stringify({ lease }), { mode: 0o600 });
    const launchEnv = { ...spec.env, PACER_HOME: ctx.pacerHome, PACER_ADMISSION_SESSION: lease, PACER_ADMISSION_DIR: spec.dir };
    // Once spawn is attempted, a thrown error does not certify no child exists.
    attempted = true;
    const proc = Bun.spawn(command, {
      detached: true, cwd: spec.cwd, env: {...launchEnv, HOME: ctx.home, PACER_HOME: ctx.pacerHome, ...(interactive ? { PACER_REPORT_TOKEN: reportToken } : {})}, stdin: "ignore", stdout: "ignore", stderr: "ignore",
    });
    proc.unref();
    writeFileSync(join(spec.dir, "pid"), String(proc.pid), { mode: 0o600 });
    return { pid: proc.pid };
  } catch (e) {
    if (lease && !attempted) finishWorkSync(ctx, lease);
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/** True only when `pid` is alive AND its command line is this run's wrapper (guards against pid reuse). */
function wrapperAlive(pid: number, dir: string): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  let ps;
  try { ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]); } catch { return false; }
  const command=ps.stdout.toString().trim();
  return ps.exitCode === 0 && (command.includes(join(dir,"run.sh")) || command.endsWith(`_session ${dir}`));
}

const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
const mtime = (f: string) => { try { return statSync(f).mtimeMs / 1000; } catch { return null; } };

export function readRun(dir: string): RunState {
  const pid = num(join(dir, "pid")), exit = num(join(dir, "exit"));
  const out = join(dir, "stdout"), err = join(dir, "stderr");
  const stdoutBytes = size(out), stderrBytes = size(err);
  const times = [stdoutBytes ? mtime(out) : null, stderrBytes ? mtime(err) : null, mtime(join(dir, "session.activity"))].filter((t): t is number => t !== null);
  let controller: string | null = null;
  try { const state = JSON.parse(readFileSync(join(dir, "session.state"), "utf8")); if (typeof state.controller === "string") controller = state.controller; } catch { /* optional session state */ }
  const interactive = existsSync(join(dir, "interactive.json"));
  const sessionMinor = interactive ? readSessionVersion(dir)?.versions[1] : undefined;
  return {
    ...(interactive && controller ? {controller} : {}),
    ...(sessionMinor ? {sessionMinor} : {}),
    ...(interactive ? {interactive: true, report: readReport(dir)} : {}),
    lastInputAt: mtime(join(dir, "session.input")),
    pid, startedAt: num(join(dir, "started")), exit, stdoutBytes, stderrBytes,
    lastOutputAt: times.length ? Math.max(...times) : null,
    alive: exit === null && pid !== null && wrapperAlive(pid, dir),
  };
}

/** TERM the run's process group, then KILL after graceMs. Returns the recorded exit, or 137 when it had to be killed. */
export async function stopRun(dir: string, o: { graceMs?: number; sleep?: (ms: number) => Promise<void>;
  /** Scoped plugin stop rechecks its persisted owner before any signal or file effect. */
  expectedIdentities?: { host: ProcessIdentity; child: ProcessIdentity }; guard?: (effect: "signal" | "write") => void; pipeOnly?: boolean; requireRecordedExit?: boolean } = {}): Promise<{ code: number; killed: boolean }> {
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const s = readRun(dir);
  if (s.exit !== null) return { code: s.exit, killed: false };
  const noReceipt = (): { code: number; killed: boolean } => {
    if (o.requireRecordedExit) throw new Error("detached run stop has no recorded exit");
    return { code: 137, killed: false };
  };
  if (s.pid === null || !s.alive) return noReceipt();
  const end = Date.now() + (o.graceMs ?? 5000);
  // The wrapper can exit before its atomic exit receipt appears. Once it is gone,
  // wait within the original grace period rather than signalling an unowned PID.
  const waitForExit = async (): Promise<number | null> => {
    for (;;) {
      const exit = readRun(dir).exit;
      if (exit !== null || Date.now() >= end) return exit;
      await sleep(50);
    }
  };
  // The parent publishes pid before the wrapper installs its traps and starts the child.
  // Wait for child readiness so an immediate stop can record a graceful TERM exit.
  while (!existsSync(join(dir, "child")) && Date.now() < end) {
    const now = readRun(dir);
    if (now.exit !== null) return { code: now.exit, killed: false };
    if (!now.alive) {
      const exit = await waitForExit();
      return exit === null ? noReceipt() : { code: exit, killed: false };
    }
    await sleep(50);
  }
  if (o.expectedIdentities) {
    const { processIdentity, sameProcess, signalSameProcess } = await import("../update/desktop/process-identity");
    const { host, child } = o.expectedIdentities;
    const matches = () => num(join(dir, "pid")) === host.pid && num(join(dir, "child")) === child.pid &&
      sameProcess(processIdentity(host.pid), host) && sameProcess(processIdentity(child.pid), child);
    if (!matches()) return { code: 137, killed: false };
    if (!signalSameProcess(child, "SIGTERM")) return { code: 137, killed: false };
    while (Date.now() < end) {
      const now = readRun(dir);
      if (now.exit !== null) return { code: now.exit, killed: false };
      await sleep(50);
    }
    if (matches()) signalSameProcess(child, "SIGKILL");
    await sleep(100);
    return { code: readRun(dir).exit ?? 137, killed: false };
  }
  const beforeTerm = readRun(dir);
  if (beforeTerm.exit !== null) return { code: beforeTerm.exit, killed: false };
  if (!beforeTerm.alive) {
    const exit = await waitForExit();
    return exit === null ? noReceipt() : { code: exit, killed: false };
  }
  o.guard?.("signal");

  if (beforeTerm.exit !== null) return { code: beforeTerm.exit, killed: false };
  if (!beforeTerm.alive) return { code: (await waitForExit()) ?? 137, killed: false };
  killTree(s.pid, "SIGTERM");
  while (Date.now() < end) {
    const now = readRun(dir);
    if (now.exit !== null) return { code: now.exit, killed: false };
    if (!now.alive) {
      const exit = await waitForExit();
      return exit === null ? noReceipt() : { code: exit, killed: false };
    }
    await sleep(50);
  }
  const beforeKill = readRun(dir);
  if (beforeKill.exit !== null) return { code: beforeKill.exit, killed: false };
  if (!beforeKill.alive) return noReceipt();
  // The PTY child owns a separate session, outside the host process group.
  const child = num(join(dir, "child"));
  if (!o.pipeOnly && child !== null && Number.isInteger(child) && child > 1) {
    o.guard?.("signal");
    killTree(child, "SIGKILL");
  }
  o.guard?.("signal");
  killTree(s.pid, "SIGKILL");
  await sleep(100);
  const after = readRun(dir);
  if (after.exit !== null) return { code: after.exit, killed: false };
  if (o.requireRecordedExit) throw new Error("detached run stop has no recorded exit");
  o.guard?.("write");
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

/** File-backed access for a local attempt. */
export function localRunIO(dir: string): RunIO {
  return { read: async () => readRun(dir), stop: (o) => stopRun(dir, o) };
}

/** Async version of readRun using fs.promises + Promise.all for parallel stat calls. */
export async function readRunAsync(dir: string): Promise<RunState> {
  const [pid, exit, stdoutStat, stderrStat, activityStat, sessionState, interactiveExists] = await Promise.all([
    readNumber(join(dir, "pid")),
    readNumber(join(dir, "exit")),
    stat(join(dir, "stdout")).catch(() => null),
    stat(join(dir, "stderr")).catch(() => null),
    stat(join(dir, "session.activity")).catch(() => null),
    readFile(join(dir, "session.state"), "utf8").catch(() => null),
    existsSync(join(dir, "interactive.json")),
  ]);

  const stdoutBytes = stdoutStat?.size ?? 0;
  const stderrBytes = stderrStat?.size ?? 0;
  const activityMtime = activityStat?.mtimeMs;
  const times = [
    stdoutBytes ? stdoutStat!.mtimeMs / 1000 : null,
    stderrBytes ? stderrStat!.mtimeMs / 1000 : null,
    activityMtime !== undefined ? activityMtime / 1000 : null,
  ].filter((t): t is number => t !== null);

  let controller: string | null = null;
  if (sessionState) {
    try { const state = JSON.parse(sessionState); if (typeof state.controller === "string") controller = state.controller; } catch { /* optional session state */ }
  }

  const interactive = interactiveExists;
  const alive = exit === null && pid !== null && wrapperAlive(pid, dir);
  const sessionMinor = interactive ? readSessionVersion(dir)?.versions[1] : undefined;

  const inputStat = await stat(join(dir, "session.input")).catch(() => null);
  const lastInputAt = inputStat?.mtimeMs !== undefined ? inputStat.mtimeMs / 1000 : null;

  return {
    ...(interactive && controller ? { controller } : {}),
    ...(sessionMinor ? { sessionMinor } : {}),
    ...(interactive ? { interactive: true, report: readReport(dir) } : {}),
    lastInputAt,
    pid, startedAt: await readNumber(join(dir, "started")), exit, stdoutBytes, stderrBytes,
    lastOutputAt: times.length ? Math.max(...times) : null,
    alive,
  };
}

async function readNumber(file: string): Promise<number | null> {
  try {
    const text = (await readFile(file, "utf8")).trim();
    const value = Number(text);
    return text && Number.isFinite(value) ? value : null;
  } catch { return null; }
}

/** The liveness subset of readRun, using asynchronous filesystem and ps probes. */
export async function readRunLiveness(dir: string): Promise<{alive: boolean; exit: number | null}> {
  // Check cache first
  const cached = getCachedLiveness(dir);
  if (cached) return cached;

  const [pid, exit] = await Promise.all([readNumber(join(dir, "pid")), readNumber(join(dir, "exit"))]);
  if (exit !== null || pid === null) {
    const result = { alive: false, exit };
    setCachedLiveness(dir, result.alive, result.exit);
    return result;
  }
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      const result = { alive: false, exit };
      setCachedLiveness(dir, result.alive, result.exit);
      return result;
    }
  }
  const alive = await new Promise<boolean>(resolve => {
    try {
      execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 2000 }, (error, stdout) => {
        const command = stdout.trim();
        resolve(!error && (command.includes(join(dir, "run.sh")) || command.endsWith(`_session ${dir}`)));
      });
    } catch { resolve(false); }
  });
  const result = { alive, exit };
  setCachedLiveness(dir, result.alive, result.exit);
  return result;
}
