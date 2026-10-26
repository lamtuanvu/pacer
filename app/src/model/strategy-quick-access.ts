/**
 * Model for strategy quick access popup.
 * Reuses types from existing models.
 */
import type { StrategyRow } from "./strategy";
import type { ProjectStrategyView } from "./project-strategies";
import type { Rule, RoutingRules } from "./executors";

export type { StrategyRow, ProjectStrategyView, Rule, RoutingRules };

/**
 * Context-aware routing info for display.
 * Combines what we know about the current repo (if any) with global strategy.
 */
export interface RoutingContext {
  /** Current repo key if context is available */
  repoKey: string | null;
  /** Repo label for display (e.g., "github.com/acme/api") */
  repoLabel: string | null;
  /** Whether this repo has a project override */
  hasProjectOverride: boolean;
  /** Project policy when override exists */
  projectPolicy?: {
    source: "project";
    repoKey: string;
    rev: number;
    /** Executor references (stable policy references) */
    executors: string[];
  };
  /** Active named strategy (always available) */
  activeStrategy: StrategyRow;
}

/**
 * Determine effective routing context from available data.
 * Pure function - no side effects.
 */
export function routingContext(
  /** Current repo key from context (query.repo or session.repo) */
  currentRepoKey: string | null,
  /** List of repos from snapshot (for label lookup) */
  knownRepos: Array<{ key: string; label: string }>,
  /** Project overrides from project.strategy.list */
  projectOverrides: ProjectStrategyView[],
  /** Active strategy info */
  activeStrategy: StrategyRow
): RoutingContext {
  // Find repo label if we have a key
  const repoLabel = currentRepoKey
    ? knownRepos.find(r => r.key === currentRepoKey)?.label ?? currentRepoKey
    : null;

  // Check if this repo has an active project override
  const override = currentRepoKey
    ? projectOverrides.find(p => p.repo.key === currentRepoKey)
    : undefined;

  const hasProjectOverride =
    override?.executors !== null &&
    override?.executors !== undefined &&
    override.executors.length > 0;

  return {
    repoKey: currentRepoKey,
    repoLabel,
    hasProjectOverride,
    projectPolicy:
      hasProjectOverride && override
        ? {
            source: "project",
            repoKey: override.repo.key,
            rev: override.rev,
            executors: [...override.executors!],
          }
        : undefined,
    activeStrategy,
  };
}

/**
 * Summary text for displaying routing context.
 * Returns user-friendly strings like:
 * - "Global: default"
 * - "Project override for acme/api: 2 executors"
 */
export function routingContextSummary(context: RoutingContext): {
  primary: string;
  secondary: string;
  badge: string;
} {
  if (context.hasProjectOverride && context.projectPolicy) {
    const count = context.projectPolicy.executors.length;
    return {
      primary: context.repoLabel ?? context.repoKey ?? "Current repo",
      secondary: `Project override: ${count} executor${count !== 1 ? "s" : ""}`,
      badge: "Project",
    };
  }

  return {
    primary: `Profile: ${context.activeStrategy.name}`,
    secondary: context.activeStrategy.summary,
    badge: context.activeStrategy.active ? "Active" : "",
  };
}
