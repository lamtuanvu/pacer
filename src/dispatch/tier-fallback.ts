import { targetTier, type Difficulty } from "./tier-select";
import type { TierTargets } from "./types";

type Tier = TierTargets[Difficulty];
/**
 * The tier the planner tier fallback guards: only complex tasks or an explicit `minTier`
 * (docs/specs/2026-11-25-planner-tier-fallback-design.md). Undefined leaves ranking unchanged.
 */
export function fallbackTier(difficulty: Difficulty | undefined, targets: TierTargets, minTier?: Tier): Tier | undefined {
  return difficulty === "complex" || minTier !== undefined ? targetTier(difficulty ?? "standard", targets, minTier) : undefined;
}
