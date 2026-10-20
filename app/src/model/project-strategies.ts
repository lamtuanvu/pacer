import type { ProjectStrategyView } from "../../../src/core/project-strategies";
import type { Routing } from "./home";
export type { ProjectStrategyView };
export function projectDraft(view: ProjectStrategyView) {
  return { repoKey: view.repo.key, rev: view.rev, executors: [...(view.executors ?? [])] };
}
export function moveExecutor(executors: readonly string[], index: number, direction: -1 | 1): string[] {
  const next = [...executors], target = index + direction;
  if (target >= 0 && target < next.length) [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
export function reconcileExecutor(executor: string, routing: Routing | undefined): string {
  if (!routing?.policy || !executor) return executor;
  return [...routing.ranked, ...routing.excluded].some(row => row.id === executor) ? executor : "";
}
