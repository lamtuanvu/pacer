import { getWork } from "../dispatch/work";
import { taskActivity } from "../tasks/activity";
import { taskTitle } from "../core/short-title";
import { loadStrategy } from "../config/strategy";
import { activeAgentSessions } from "../session/agents-state";
import { agentChecksPending } from "../session/agents-checks";
import { pidAlive } from "../link/store";
import { killTree } from "../exec/process";
import { RemoteRunIO } from "../remote/run-io";
import { summarizeTask } from "../tasks/api";
import { readTask } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

/** Whether native `task.stop` must forward to the TypeScript reference handler. */
export function taskStopProbe(ctx: Ctx, id: string) {
  if (getWork(ctx, id)) return { forward: true as const, reason: "managed work" };
  if (agentChecksPending(ctx, id) || activeAgentSessions(ctx).some(s => s.task_id === id)) {
    return { forward: true as const, reason: "agent session" };
  }
  const task = readTask(ctx, id);
  if (!task) return { forward: false as const, runnerAlive: false, beforeState: null as string | null };
  const runnerAlive = task.state === "running" && task.runnerPid != null && pidAlive(task.runnerPid);
  return { forward: false as const, runnerAlive, beforeState: task.state };
}

async function applyTaskStopSignals(ctx: Ctx, t: TaskRecord) {
  if (t.stopPending) return;
  if (t.state === "needs_input" && t.live) {
    await import("../exec/live").then(m => m.releaseLiveWorker(ctx, t, "the task was stopped")).catch(() => {});
    return;
  }
  if (t.run?.host && t.run.remoteDir) {
    try {
      const host = loadStrategy(ctx).hosts[t.run.host];
      if (host) {
        void new RemoteRunIO(ctx, host, t.run.remoteDir, t.run.dir)
          .stop({ graceMs: 5000, sleep: ms => Bun.sleep(ms) })
          .catch(() => {});
      }
    } catch { /* supervisor retries */ }
    return;
  }
  if (t.childPid) killTree(t.childPid, "SIGTERM");
}

/** Effectful sides after Rust `record_task_stop`; Core remains authoritative for signals and activity. */
export async function taskStopAfterStore(ctx: Ctx, id: string, beforeState: string | null) {
  const after = readTask(ctx, id);
  if (!after) throw new Error(`unknown task ${id}`);
  await applyTaskStopSignals(ctx, after);
  if (beforeState && !TERMINAL_STATES.includes(beforeState as TaskRecord["state"])
    && TERMINAL_STATES.includes(after.state)) {
    taskActivity(ctx, after, "task_settled", `Stopped “${taskTitle(after)}”`);
  }
  return summarizeTask(after);
}
