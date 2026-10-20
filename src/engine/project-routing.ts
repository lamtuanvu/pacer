import type { Strategy } from "../config/strategy";
import type { ProjectStrategyEntry } from "../config/project-strategies";
import { resolveRunner } from "../config/runner-id";
import type { RunnerCfg } from "../config/accounts";
import { CoreError } from "../core/errors";

export interface ProjectSelection {
  repoKey: string;
  rev: number;
  references: readonly string[];
  executors: readonly string[];
}
export const runnerReference = (runner: RunnerCfg): string => `${runner.agent}#${runner.account}@${runner.host ?? "local"}`;

/** Resolve aliases once when saving; never let a later default account inherit permission. */
export function projectReferences(strategy: Strategy, ids: readonly string[]): string[] {
  if (!ids.length) throw new CoreError("invalid_input", "Choose at least one executor", "Remove the override to use the global strategy.");
  const references = ids.map(id => {
    const runner = resolveRunner(strategy, id);
    if (!runner) throw new CoreError("invalid_input", `Unknown executor ${id}`);
    if (runner.agent === strategy.planner.agent && runner.account === strategy.planner.account) throw new CoreError("invalid_input", `${id} is the planner`);
    return runnerReference(runner);
  });
  if (new Set(references).size !== references.length) throw new CoreError("invalid_input", "Duplicate project executor");
  return references;
}

export function resolveProjectSelection(strategy: Strategy, repoKey: string, entries: Readonly<Record<string, ProjectStrategyEntry>>): ProjectSelection | undefined {
  const entry = Object.hasOwn(entries, repoKey) ? entries[repoKey] : undefined;
  if (!entry?.executors) return undefined;
  const runners = Object.values(strategy.runners);
  return { repoKey, rev: entry.rev, references: entry.executors,
    executors: entry.executors.map(ref => runners.find(runner => runnerReference(runner) === ref)?.id ?? ref) };
}

export function projectPolicy(selection: ProjectSelection | undefined) {
  return selection ? { source: "project" as const, repoKey: selection.repoKey, rev: selection.rev, executors: [...selection.references] } : undefined;
}
