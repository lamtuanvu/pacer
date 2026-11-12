import type { ModelRecord, TierTargets } from "../../../src/dispatch/types";
import { TIERS } from "../../../src/dispatch/candidates";
import { selectModel } from "../../../src/dispatch/tier-select";
import { displayModel, difficultyLabels } from "./executor-models";

// Pure logic for the Settings › Dispatcher › Model choice grid and its preview.
// The grid itself keeps `dispatch.tierTargets` non-decreasing from simple to
// complex, so the schema's decrease validation can no longer be reached.

export type RatedTier = "small" | "medium" | "frontier";
export const RATED_TIERS: readonly RatedTier[] = ["small", "medium", "frontier"];
export type Difficulty = "simple" | "standard" | "complex";
export const DIFFICULTIES: readonly Difficulty[] = ["simple", "standard", "complex"];

const RATING: Record<RatedTier, number> = { small: TIERS.small, medium: TIERS.medium, frontier: TIERS.frontier };
const DIFF_INDEX: Record<Difficulty, number> = { simple: 0, standard: 1, complex: 2 };

/** Pick `tier` for `difficulty`, lowering earlier rows to at most it and raising later rows to at least it. */
export function adjustTier(targets: TierTargets, difficulty: Difficulty, tier: RatedTier): TierTargets {
  const values = DIFFICULTIES.map(d => RATING[targets[d]]);
  const at = DIFF_INDEX[difficulty];
  values[at] = RATING[tier];
  for (let i = 0; i < at; i++) values[i] = Math.min(values[i], RATING[tier]);
  for (let i = at + 1; i < DIFFICULTIES.length; i++) values[i] = Math.max(values[i], RATING[tier]);
  const next = {} as TierTargets;
  DIFFICULTIES.forEach((d, i) => { next[d] = RATED_TIERS.find(t => RATING[t] === values[i])!; });
  return next;
}

export const PRESETS = {
  economical: { simple: "small", standard: "small", complex: "medium" },
  balanced: { simple: "small", standard: "medium", complex: "frontier" },
  quality: { simple: "medium", standard: "frontier", complex: "frontier" },
  frontier: { simple: "frontier", standard: "frontier", complex: "frontier" },
} as const satisfies Record<string, TierTargets>;
export type PresetName = keyof typeof PRESETS;
export const PRESET_LABELS: Record<PresetName, string> = {
  economical: "Economical", balanced: "Balanced", quality: "Quality first", frontier: "Frontier only",
};
export type PresetMatch = PresetName | "custom";
export function matchingPreset(targets: TierTargets): PresetMatch {
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    const preset = PRESETS[name];
    if (preset.simple === targets.simple && preset.standard === targets.standard && preset.complex === targets.complex) return name;
  }
  return "custom";
}
export function applyPreset(_targets: TierTargets, name: PresetName): TierTargets {
  return { ...PRESETS[name] } as TierTargets;
}

// Preview grouping uses selectModel exactly as the dispatcher does.
type Records = ModelRecord[];
const isExact = (r: ModelRecord): r is ModelRecord & { binding: { kind: "exact"; id: string } } => r.binding.kind === "exact";
const isRatedExact = (r: ModelRecord): r is ModelRecord & { binding: { kind: "exact"; id: string } } => isExact(r) && r.tier !== "unknown";
const hasExact = (list: Records) => list.some(isExact);

/** The executor is steered when at least one of its exact models has a rated tier. */
export function steeredCount(records: readonly ModelRecord[]): { steered: number; total: number } {
  const byRunner = new Map<string, ModelRecord[]>();
  for (const record of records) byRunner.set(record.runner, [...(byRunner.get(record.runner) ?? []), record]);
  let steered = 0;
  for (const [, list] of byRunner) if (hasExact(list) && list.some(isRatedExact)) steered++;
  return { steered, total: byRunner.size };
}

export interface FollowCell {
  difficulty: Difficulty;
  target: RatedTier;
  chosen: string | null;
  note: string;
  skipped: boolean;
}
export interface FollowRow { runner: string; model: string; tier: RatedTier | null; cells: FollowCell[] }
export interface UnratedRow { runner: string; model: string }
export interface FixedRow { runner: string }
export interface PreviewCol { difficulty: Difficulty; target: RatedTier; eligible: number }
export interface PreviewGrouping {
  steered: number; total: number;
  follow: FollowRow[]; unrated: UnratedRow[]; fixed: FixedRow[];
  cols: PreviewCol[];
}

function followCell(list: Records, difficulty: Difficulty, targets: TierTargets, defaultModel: string | undefined): FollowCell {
  const target = targets[difficulty];
  // Mirror plain delegation (src/tasks/runner.ts): pass fixedExecutor and the
  // runner's default so a below-target executor falls back to its default
  // rather than reporting "Not used".
  const chosen = selectModel(list, { difficulty, targets, fixedExecutor: true, defaultModel });
  const record = chosen.record;
  if (record && record.binding.kind === "exact") {
    const tier = record.tier;
    const note = tier === "unknown"
      ? "Model has no rating"
      : TIERS[tier] > TIERS[target] ? "Larger than needed, used when nothing smaller is free"
      : TIERS[tier] === TIERS[target] ? "Matches the target"
      : "Smaller than the target";
    return { difficulty, target, chosen: displayModel(record.binding.id), note, skipped: false };
  }
  if (record && record.binding.kind === "executor-default") {
    return { difficulty, target, chosen: "default model", note: "Runs its default model below the target", skipped: false };
  }
  // No exact model rated at/above the target and no configured default. Plain
  // delegation still runs the executor's provider-configured model when it is
  // chosen, so show that instead of "Not used"; "Not used" remains only for an
  // executor that truly has nothing in the inventory it can run.
  if (list.length > 0) {
    return { difficulty, target, chosen: "Uses its provider's default", note: "No rated model at the target", skipped: false };
  }
  return { difficulty, target, chosen: null, note: "Model is smaller than the target", skipped: true };
}

export function groupPreview(records: readonly ModelRecord[], targets: TierTargets, defaultModelById?: Readonly<Record<string, string>>): PreviewGrouping {
  const byRunner = new Map<string, ModelRecord[]>();
  for (const record of records) byRunner.set(record.runner, [...(byRunner.get(record.runner) ?? []), record]);
  const behavior = new Map<string, "follow" | "unrated" | "fixed">();
  for (const [runner, list] of byRunner) {
    if (!hasExact(list)) behavior.set(runner, "fixed");
    else if (list.some(isRatedExact)) behavior.set(runner, "follow");
    else behavior.set(runner, "unrated");
  }
  const follow: FollowRow[] = [], unrated: UnratedRow[] = [], fixed: FixedRow[] = [];
  let steered = 0;
  for (const [runner, list] of byRunner) {
    const kind = behavior.get(runner)!;
    if (kind === "fixed") { fixed.push({ runner }); continue; }
    if (kind === "follow") {
      steered++;
      const seed = list.find(isRatedExact)!;
      follow.push({
        runner,
        model: displayModel(seed.binding.id),
        tier: seed.tier as RatedTier,
        cells: DIFFICULTIES.map(difficulty => followCell(list, difficulty, targets, defaultModelById?.[runner])),
      });
    } else {
      const seed = list.find(isExact);
      unrated.push({ runner, model: seed ? displayModel(seed.binding.id) : "" });
    }
  }
  const total = byRunner.size;
  return {
    steered, total, follow, unrated, fixed,
    cols: DIFFICULTIES.map(difficulty => {
      const target = targets[difficulty];
      let eligible = 0;
      for (const [runner] of byRunner) {
        const kind = behavior.get(runner)!;
        // fixed and unrated executors take any difficulty; a follow executor
        // always runs a rated model, its configured default, or its provider's
        // default for the difficulty (see followCell), so it can take it too.
        // Only an executor with nothing in the inventory it can run is excluded.
        if (kind === "fixed" || kind === "unrated" || kind === "follow") eligible++;
      }
      return { difficulty, target, eligible };
    }),
  };
}

/**
 * Sentence explaining why difficulty steers nothing, built from the non-empty
 * unrated/fixed groups only (a zero clause is never printed). Picks correct
 * agreement for both singular and plural executors.
 */
export function unsteeredCopy(unrated: number, fixed: number): string {
  const parts: string[] = [];
  if (unrated > 0) parts.push(`${unrated} ${unrated === 1 ? "executor runs a model nobody has rated" : "executors run models nobody has rated"}`);
  if (fixed > 0) parts.push(`${fixed} ${fixed === 1 ? "executor picks its own model" : "executors pick their own model"}`);
  return parts.length ? `${parts.join(", and ")}, so every task gets the same model whatever its difficulty.` : "";
}

/** Readable heading strings used by the preview, mirroring the view-model copy style. */
export const DIFFICULTY_TITLES = difficultyLabels;