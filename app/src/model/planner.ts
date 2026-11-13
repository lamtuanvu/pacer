import type { ModelRecord } from "../../../src/dispatch/types";

// The planner is the executor that drives Pacer, so its models are not
// dispatch targets. Both the Model choice preview and the Model matrix share
// one way of finding it: the dispatch.models record whose account matches the
// config's plannerAccount and whose executor is the planner agent, with no
// host in the runner id.

/** The planner's runner id within a model inventory, or null when no record matches. */
export function plannerRunner(
  records: readonly ModelRecord[],
  planner: string | null | undefined,
  plannerAccount: string | null | undefined,
): string | null {
  if (!planner || !plannerAccount) return null;
  const match = records.find(r =>
    r.account === plannerAccount && r.executor === planner && !r.runner.includes("@"));
  return match?.runner ?? null;
}

/** True when `runner` is the planner's runner in this inventory. */
export function isPlannerRunner(
  records: readonly ModelRecord[],
  runner: string,
  planner: string | null | undefined,
  plannerAccount: string | null | undefined,
): boolean {
  return plannerRunner(records, planner, plannerAccount) === runner;
}

/** The inventory without the planner's records, so counts cover only dispatch targets. */
export function withoutPlanner(
  records: readonly ModelRecord[],
  planner: string | null | undefined,
  plannerAccount: string | null | undefined,
): ModelRecord[] {
  const id = plannerRunner(records, planner, plannerAccount);
  if (!id) return [...records];
  return records.filter(r => r.runner !== id);
}