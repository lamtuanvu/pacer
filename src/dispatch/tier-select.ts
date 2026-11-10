import { TIERS } from "./candidates";
import type { ModelRecord, TierTargets } from "./types";

export type Difficulty = "simple" | "standard" | "complex";
export type TierReason = "target-match" | "upward-fallback" | "unknown-tier-fallback" | "explicit-override" | "executor-fixed-below-target";
type Tier = TierTargets[Difficulty];
export interface TierChoice {
  record: ModelRecord | null;
  targetTier: Tier;
  selectedTier: ModelRecord["tier"] | null;
  reason: TierReason;
}

export function targetTier(difficulty: Difficulty, targets: TierTargets, minTier?: Tier): Tier {
  const target = targets[difficulty];
  return minTier !== undefined && TIERS[minTier] > TIERS[target] ? minTier : target;
}

/** Preserve the caller's ranking within each tier; never mutate its inventory. */
export function tierBuckets<T extends { tier: ModelRecord["tier"] }>(items: T[], target: Tier): T[][] {
  const tiers = (["small", "medium", "frontier"] as const).filter(tier => TIERS[tier] >= TIERS[target]);
  return [...tiers, "unknown"].map(tier => items.filter(item => item.tier === tier));
}

export function selectModel(records: ModelRecord[], o: {
  difficulty: Difficulty;
  targets: TierTargets;
  minTier?: Tier;
  pin?: string;
  fixedExecutor?: boolean;
  /** Full model ID configured as the runner's default. */
  defaultModel?: string;
  isUsable?: (record: ModelRecord) => boolean;
}): TierChoice {
  const target = targetTier(o.difficulty, o.targets, o.minTier);
  const choice = (record: ModelRecord | undefined, reason: TierReason): TierChoice => ({
    record: record ?? null, targetTier: target, selectedTier: record?.tier ?? null, reason,
  });
  const eligible = records.filter(record =>
    (o.minTier === undefined || TIERS[record.tier] >= TIERS[o.minTier]) && (o.isUsable?.(record) ?? true));
  if (o.pin !== undefined) {
    return choice(eligible.find(record => record.binding.kind === "exact" && record.binding.id === o.pin), "explicit-override");
  }
  for (const bucket of tierBuckets(eligible, target)) {
    const record = bucket[0];
    if (record && record.tier !== "unknown") {
      return choice(record, record.tier === target ? "target-match" : "upward-fallback");
    }
  }
  if (o.fixedExecutor) {
    const record = eligible.find(record => record.binding.kind === "exact" && record.binding.id === o.defaultModel)
      ?? eligible.find(record => record.binding.kind === "executor-default");
    return choice(record, "executor-fixed-below-target");
  }
  const unknown = eligible.find(record => record.tier === "unknown");
  return choice(unknown, unknown ? "unknown-tier-fallback" : "target-match");
}
