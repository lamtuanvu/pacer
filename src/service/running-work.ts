import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listTasksWhere, readTask } from "../tasks/store";
import { listTerminals, terminalDirectory } from "../terminal/workspace";
import { readRun, stopRun } from "../supervisor/run";
import { hostVersionView, readSessionVersion } from "../session/protocol";
import { processIdentity, sameProcess, signalSameProcess } from "../update/desktop/process-identity";
import { pidAlive } from "../link/store";
import { taskStop, settleLiveReleases } from "../tasks/api";
import { liveWorkerOwned } from "../exec/live";
import { compareVersions, currentVersion, isVersion } from "../update/version";
import type { Ctx } from "../types";

export interface RunningTask { taskId: string; runnerPacer: string | null; older: boolean }
export interface RunningSession { kind: "task" | "terminal"; id: string; pacer: string | null; older: boolean; reopenToUpdate: boolean }
export interface RunningWork { pacer: string; tasks: RunningTask[]; sessions: RunningSession[] }
export interface RunningWorkCounts { tasks: number; sessions: number; olderRunners: number; olderSessions: number; reopenToUpdate: number }

const older = (version: string | null, current: string) => {
  if (!version) return true;
  try { return compareVersions(version, current) < 0; } catch { return true; }
};

/** Running tasks and live session hosts, with versions only: never paths. */
export async function runningWork(ctx: Ctx, current = currentVersion()): Promise<RunningWork> {
  const tasks: RunningTask[] = [], sessions: RunningSession[] = [];
  for (const t of listTasksWhere(ctx, { states: ["running", "needs_input"] })) {
    if (t.state === "needs_input" && !liveWorkerOwned(t, ctx.now, id => readTask(ctx, id))) continue;
    const runnerPacer = t.runnerPacer ?? t.handover?.pacer ?? null;
    tasks.push({ taskId: t.id, runnerPacer, older: older(runnerPacer, current) });
    const dir = t.run && !t.run.host ? t.run.dir : undefined;
    if (dir && existsSync(join(dir, "session.json")) && readRun(dir).alive) {
      const host = hostVersionView(dir, current);
      sessions.push({ kind: "task", id: t.id, pacer: host.pacer, older: host.older, reopenToUpdate: !host.supported });
    }
  }
  for (const terminal of await listTerminals(ctx)) {
    if (!terminal.live) continue;
    const host = hostVersionView(terminalDirectory(ctx, terminal.id), current);
    sessions.push({ kind: "terminal", id: terminal.id, pacer: host.pacer, older: host.older, reopenToUpdate: !host.supported });
  }
  return { pacer: current, tasks, sessions };
}

export function workCounts(work: RunningWork): RunningWorkCounts {
  return {
    tasks: work.tasks.length, sessions: work.sessions.length,
    olderRunners: work.tasks.filter(t => t.older).length,
    olderSessions: work.sessions.filter(s => s.older).length,
    reopenToUpdate: work.sessions.filter(s => s.reopenToUpdate).length,
  };
}

/** `pacer status` lines: totals, then each task or session still on an older runner or host. */
export function runningWorkLines(work: RunningWork): string[] {
  const c = workCounts(work);
  if (!c.tasks && !c.sessions) return [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const safe = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  const version = (value: string | null) => value && isVersion(value) ? value : "from an older release";
  return [
    `running work: ${plural(c.tasks, "task")}, ${plural(c.sessions, "session")}`,
    ...work.tasks.filter(t => t.older).map(t => `  task ${safe(t.taskId)} on runner ${version(t.runnerPacer)} (older)`),
    ...work.sessions.filter(s => s.older).map(s => `  ${s.kind === "terminal" ? "terminal" : "session"} ${safe(s.id)} on host ${version(s.pacer)} (older${s.reopenToUpdate ? "; Reopen to update" : ""})`),
  ];
}

export interface StopReport { stopped: string[]; skipped: { id: string; reason: string }[] }

/** A terminal's shell must still be a child of its recorded session host. */
export function terminalChildBelongsToHost(childPid: number, hostPid: number): boolean {
  if (!Number.isSafeInteger(childPid) || childPid <= 1 || childPid === process.pid) return false;
  try {
    const p = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(childPid)], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 && Number(p.stdout.toString().trim()) === hostPid;
  } catch { return false; }
}

/** Executors launch detached as process group leaders. Check that fact before group signalling. */
function signalExecutorGroup(pid: number, identity: NonNullable<ReturnType<typeof processIdentity>>): boolean {
  if (pid <= 1 || !sameProcess(processIdentity(pid), identity)) return false;
  try {
    const p = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    if (p.exitCode !== 0 || Number(p.stdout.toString().trim()) !== pid || !sameProcess(processIdentity(pid), identity)) return false;
    process.kill(-pid, "SIGTERM");
    return true;
  } catch { return false; }
}

/** Stop only work whose process identity is confirmed or whose runner still supervises it. */
export async function stopRunningWork(ctx: Ctx): Promise<StopReport> {
  const report: StopReport = { stopped: [], skipped: [] };
  for (const t of listTasksWhere(ctx, { states: ["queued", "running", "needs_input"] })) {
    if (t.state === "needs_input" && !liveWorkerOwned(t, ctx.now, id => readTask(ctx, id))) continue;
    const verified = !!t.childPid && !!t.childIdentity && sameProcess(processIdentity(t.childPid), t.childIdentity);
    const supervised = !!t.runnerPid && pidAlive(t.runnerPid);
    if (!verified && !supervised && t.state === "running") { report.skipped.push({ id: t.id, reason: "its process identity could not be confirmed and no runner supervises it" }); continue; }
    if (verified && !signalExecutorGroup(t.childPid!, t.childIdentity!) && !signalSameProcess(t.childIdentity!, "SIGTERM")) {
      report.skipped.push({ id: t.id, reason: "its checked executor could not be signalled" }); continue;
    }
    const stopped = taskStop(ctx, t.id, { signal: false });
    if (t.state === "needs_input") await settleLiveReleases();
    if (!stopped) { report.skipped.push({ id: t.id, reason: "the task was no longer available" }); continue; }
    if (t.state === "needs_input" && readTask(ctx, t.id)?.live) {
      report.skipped.push({ id: t.id, reason: "its live worker release is pending" }); continue;
    }
    report.stopped.push(t.id);
  }
  for (const terminal of await listTerminals(ctx)) {
    if (!terminal.live) continue;
    const dir = terminalDirectory(ctx, terminal.id), host = readSessionVersion(dir), pid = readRun(dir).pid;
    if (!host?.identity || pid === null || host.identity.pid !== pid || !sameProcess(processIdentity(pid), host.identity)) {
      report.skipped.push({ id: terminal.id, reason: "its session host identity could not be confirmed" }); continue;
    }
    let childPid = 0;
    try { childPid = Number(readFileSync(join(dir, "child"), "utf8").trim()); } catch { /* no shell to signal */ }
    const child = processIdentity(childPid);
    if (!child || !terminalChildBelongsToHost(childPid, pid)) { report.skipped.push({ id: terminal.id, reason: "its shell identity could not be confirmed" }); continue; }
    await stopRun(dir, { graceMs: 2000, expectedIdentities: { host: host.identity, child } });
    if (readRun(dir).exit === null) { report.skipped.push({ id: terminal.id, reason: "the checked shell did not stop" }); continue; }
    report.stopped.push(terminal.id);
  }
  return report;
}
