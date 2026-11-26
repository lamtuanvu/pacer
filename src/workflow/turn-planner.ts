import { isPlannerRunner, resolveRunner } from "../config/runner-id";
import type { Strategy } from "../config/strategy";
import { rankExecutors, type ProviderStatus } from "../engine/rank";
import { updateTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import { getRun } from "./store";
import { liveTurnForTask } from "./wakeups";

/**
 * An orchestrator turn (task kind `orchestrate`) holds the run grant, which reviews and merges work,
 * so only the run's planner may take it (P3, API-5b). Executors are never candidates.
 */

/** The root run an orchestrator task was created for. */
export function orchestratorRootRun(task: Pick<TaskRecord, "requestId">): string | undefined {
  return typeof task.requestId === "string" ? /^orch:(.+)$/.exec(task.requestId)?.[1] : undefined;
}

/** The runner a stored planner name means. The strategy planner's agent name means its configured account. */
export function plannerRunnerId(s: Strategy, name: string): string {
  const configured = name === s.planner.agent ? Object.values(s.runners).find(r => isPlannerRunner(s, r)) : undefined;
  return configured?.id ?? resolveRunner(s, name)?.id ?? name;
}

/** The runner that is the planner of this task's run: the live turn's planner, else the run's (a queued switch first), else the strategy's. */
export function turnPlanner(ctx: Ctx, s: Strategy, task: Pick<TaskRecord, "id" | "requestId">): string {
  const root = orchestratorRootRun(task);
  const turn = liveTurnForTask(ctx, task.id, root);
  const run = !turn && root ? getRun(ctx, root) : null;
  const name = turn?.planner ?? run?.pendingPlanner ?? run?.planner ?? s.planner.agent;
  return plannerRunnerId(s, name);
}

/** Store the planner as the turn's executor, replacing anything a message turn or an older version wrote. */
export function pinTurnPlanner(ctx: Ctx, s: Strategy, task: TaskRecord): TaskRecord {
  const planner = turnPlanner(ctx, s, task);
  return task.requestedExecutor === planner ? task : updateTask(ctx, task.id, t => { t.requestedExecutor = planner; });
}

/** A pool of one: routing rules and the tier fallback never add another runner. */
export function rankTurnPlanner(planner: string, s: Strategy, statuses: Record<string, ProviderStatus>): ReturnType<typeof rankExecutors> {
  return rankExecutors("orchestrate", s, statuses, { executors: [planner], order: "configured" }, { includePlanner: true });
}

export function plannerWaitDetail(planner: string, reason: string | undefined): string {
  return `Planner ${planner} is unavailable (${reason ?? "not eligible"}); orchestrator turns run only on the run's planner`.slice(0, 500);
}
