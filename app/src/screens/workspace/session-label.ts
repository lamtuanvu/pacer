import { agentSessionLabel, executorLabel } from '../../../../src/view-model/words';

type TaskIdentity = { rev?: number; executor?: string | null; fullTitle?: string; title?: string; goal?: string };
function taskName(task?: TaskIdentity): string | undefined {
  return task?.fullTitle || task?.title || task?.goal;
}

/** Task identity distinguishes sessions even when every task uses the same executor. */
export function workspaceSessionLabel(task?: TaskIdentity): string {
  return taskName(task) || (task?.executor ? executorLabel(task.executor) : 'Task');
}

export function workspaceAgentLabel(task: TaskIdentity | undefined, agent: { executor: string; ordinal: number }): string {
  return `${taskName(task) || 'Task'} · ${agentSessionLabel(agent.executor, agent.ordinal)}`;
}

/** Callers order authoritative reads first; embedded owner rows are only a fallback. */
export function latestWorkspaceTask(...tasks: (TaskIdentity | undefined)[]): TaskIdentity | undefined {
  return tasks.reduce<TaskIdentity | undefined>((latest, task) =>
    task && (!latest || (task.rev ?? 0) > (latest.rev ?? 0)) ? task : latest, undefined);
}
