import { activeAgentSessions } from "../session/agents-state";
import { agentChecksPending } from "../session/agents-checks";
import { readTask } from "../tasks/store";
import { TERMINAL_STATES, type TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";

function waitSettled(ctx: Ctx, id: string, task: TaskRecord) {
  return TERMINAL_STATES.includes(task.state)
    && !agentChecksPending(ctx, id)
    && !activeAgentSessions(ctx).some(s => s.task_id === id);
}

/** Whether native `task.wait` must forward to the TypeScript reference handler. */
export function taskWaitProbe(ctx: Ctx, id: string) {
  if (agentChecksPending(ctx, id) || activeAgentSessions(ctx).some(s => s.task_id === id)) {
    return { forward: true as const, reason: "agent session" };
  }
  const task = readTask(ctx, id);
  if (!task) return { forward: false as const, reason: "missing" };
  if (!waitSettled(ctx, id, task)) return { forward: true as const, reason: "not settled" };
  return { forward: false as const, reason: "settled" };
}
