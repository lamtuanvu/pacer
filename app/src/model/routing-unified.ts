import type { Rule, RoutingRules } from "./executors";
import type { StrategyRow } from "./strategy";
import type { ProjectStrategyView } from "./project-strategies";
export type { Rule, RoutingRules, StrategyRow, ProjectStrategyView };

/**
 * Unified routing view that combines:
 * - Global routing rules
 * - Active strategy info
 * - Project-level overrides
 * - Computed effective routing for any repo
 */
export interface UnifiedRoutingView {
  /** Global routing rules (from executors model) */
  globalRules: RoutingRules;
  /** Active strategy metadata (name, active status, summary) */
  activeStrategy: StrategyRow;
  /** All project override configurations */
  projectOverrides: ProjectStrategyView[];
  /** Available executor IDs (from global rules, for convenience) */
  availableExecutors: string[];
}

/**
 * Per-repo effective routing view.
 * Tells you what routing applies for a specific repository.
 */
export interface EffectiveRouting {
  /** The repo key this effective routing applies to */
  repoKey: string;
  /** Whether this repo has a project override (true) or uses global routing (false) */
  hasProjectOverride: boolean;
  /**
   * Project policy when override exists.
   * Contains: source ("project"), repoKey, rev, executors (references)
   */
  projectPolicy?: { source: "project"; repoKey: string; rev: number; executors: string[] };
  /**
   * Effective executor IDs in priority order.
   * If hasProjectOverride=true, these are the executors from the project override.
   * If hasProjectOverride=false, this is undefined (caller uses kind-based global rules).
   */
  effectiveExecutorIds?: string[];
  /**
   * Effective executor references (stable policy references).
   * If hasProjectOverride=true, these are the stable references from the override.
   */
  effectiveExecutorReferences?: string[];
  /**
   * Kind-based global routing rules that apply when hasProjectOverride=false.
   * Use the appropriate rule for the task kind.
   */
  globalRules: Rule[];
}

/**
 * Build a unified routing view from its components.
 * Pure function that follows existing app/model patterns.
 */
export function unifiedView(
  globalRules: RoutingRules,
  activeStrategy: StrategyRow,
  projectOverrides: ProjectStrategyView[]
): UnifiedRoutingView {
  return {
    globalRules,
    activeStrategy,
    projectOverrides,
    availableExecutors: [...globalRules.available],
  };
}

/**
 * Find a project override by repo key, if one exists.
 * Returns undefined when the repo uses global routing.
 */
export function findProjectOverride(
  projectOverrides: ProjectStrategyView[],
  repoKey: string
): ProjectStrategyView | undefined {
  return projectOverrides.find(p => p.repo.key === repoKey);
}

/**
 * Check if a repo has a project override with explicit executors configured.
 * Note: A project override with executors=null means "use global routing" for that repo.
 */
export function hasActiveProjectOverride(
  projectOverrides: ProjectStrategyView[],
  repoKey: string
): boolean {
  const override = findProjectOverride(projectOverrides, repoKey);
  return override?.executors !== null && override?.executors !== undefined && override.executors.length > 0;
}

/**
 * Determine the effective routing for a given repo key.
 * 
 * Pure logic:
 * - If the repo has a project override (with non-null executors), return that policy
 * - Otherwise, return the global kind-based routing rules
 * 
 * Matches the core logic from src/engine/project-routing.ts:resolveProjectSelection
 * and src/core/routing.ts:route.
 */
export function effectiveRoutingForRepo(
  projectOverrides: ProjectStrategyView[],
  globalRules: RoutingRules,
  repoKey: string
): EffectiveRouting {
  const override = findProjectOverride(projectOverrides, repoKey);
  // Use local const for type narrowing
  const execs = override?.executors;
  const hasOverride = execs !== null && execs !== undefined && execs.length > 0;

  if (hasOverride && override && execs) {
    // Project override is active
    return {
      repoKey,
      hasProjectOverride: true,
      projectPolicy: {
        source: "project",
        repoKey: override.repo.key,
        rev: override.rev,
        executors: [...execs],
      },
      effectiveExecutorIds: override.available
        .filter(a => execs.includes(a.reference))
        .sort((a, b) => execs.indexOf(a.reference) - execs.indexOf(b.reference))
        .map(a => a.id),
      effectiveExecutorReferences: [...execs],
      globalRules: globalRules.rules,
    };
  }

  // Uses global routing
  return {
    repoKey,
    hasProjectOverride: false,
    globalRules: globalRules.rules,
  };
}

/**
 * Get the global routing rule that applies to a given task kind.
 * 
 * Matching logic (from src/config/strategy.ts and core routing):
 * 1. Find first rule where kinds includes the given kind
 * 2. If no match, find first rule with kinds=null (catch-all rule)
 * 3. If neither, return undefined (no routing configured)
 */
export function globalRuleForKind(
  rules: Rule[],
  kind: string | null
): Rule | undefined {
  if (!rules.length) return undefined;

  // If kind is specified, find a rule matching that kind
  if (kind !== null) {
    const byKind = rules.find(r => r.kinds?.includes(kind));
    if (byKind) return byKind;
  }

  // Find catch-all rule (kinds=null or kinds undefined/empty in a catch-all sense)
  // In RouteRule from config: kinds: string[] | null means null=catch-all
  const catchAll = rules.find(r => r.kinds === null || (Array.isArray(r.kinds) && r.kinds.length === 0));
  if (catchAll) return catchAll;

  // Fallback: first rule
  return rules[0];
}

/**
 * Summarize where executors come from for a repo.
 * Returns: "project" if override, "global" if default rules.
 */
export function routingSourceForRepo(
  projectOverrides: ProjectStrategyView[],
  repoKey: string
): "project" | "global" {
  return hasActiveProjectOverride(projectOverrides, repoKey) ? "project" : "global";
}

/**
 * List all repo keys that have active project overrides.
 * Useful for displaying which repos diverge from global routing.
 */
export function reposWithProjectOverrides(
  projectOverrides: ProjectStrategyView[]
): string[] {
  return projectOverrides
    .filter(p => p.executors !== null && p.executors !== undefined && p.executors.length > 0)
    .map(p => p.repo.key);
}
