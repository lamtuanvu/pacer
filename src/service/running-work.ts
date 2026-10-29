import { existsSync } from "node:fs";
import { join } from "node:path";
import { listTasksWhere } from "../tasks/store";
import { listTerminals, terminalDirectory } from "../terminal/workspace";
import { readRun } from "../supervisor/run";
import { hostVersionView } from "../session/protocol";
import { compareVersions, currentVersion } from "../update/version";
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
  for (const t of listTasksWhere(ctx, { states: ["running"] })) {
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
  return [
    `running work: ${plural(c.tasks, "task")}, ${plural(c.sessions, "session")}`,
    ...work.tasks.filter(t => t.older).map(t => `  task ${t.taskId} on runner ${t.runnerPacer ?? "from an older release"} (older)`),
    ...work.sessions.filter(s => s.older).map(s => `  ${s.kind === "terminal" ? "terminal" : "session"} ${s.kind === "terminal" ? s.id.slice(0, 8) : s.id} on host ${s.pacer ?? "from an older release"} (older${s.reopenToUpdate ? "; Reopen to update" : ""})`),
  ];
}
