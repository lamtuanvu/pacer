import { activeAgentSessions, agentSessionsRevision } from "../session/agents-state";
import { pidAlive } from "../link/store";
import { listTasksWhere } from "../tasks/store";
import type { Ctx } from "../types";

/** Injection payload for native `task.list` (and later `task.get`) read-model composition. */
export function sessionProbeParts(ctx: Ctx) {
  const active = activeAgentSessions(ctx).map(session => ({
    task_id: session.task_id,
    executor: session.executor,
  }));
  const alivePids = [
    ...new Set(
      listTasksWhere(ctx, { states: ["queued", "running"] })
        .map(task => task.runnerPid)
        .filter((pid): pid is number => pid != null && pidAlive(pid)),
    ),
  ];
  return { revision: agentSessionsRevision(ctx), active, alivePids };
}
