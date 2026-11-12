import { expect, test } from "bun:test";
import type { ModelRecord, TierTargets } from "../src/dispatch/types";
import { TIERS } from "../src/dispatch/candidates";
import {
  adjustTier, applyPreset, matchingPreset, PRESETS, PRESET_LABELS, steeredCount, groupPreview,
  DIFFICULTIES, RATED_TIERS, type RatedTier,
} from "../app/src/model/tier-targets";

const balanced: TierTargets = { simple: "small", standard: "medium", complex: "frontier" };

function model(runner: string, over?: Partial<ModelRecord>): ModelRecord {
  return {
    runner, account: runner, executor: runner,
    binding: { kind: "executor-default" }, actualModel: null, tier: "unknown",
    strengths: [], provenance: "declared", ...over,
  } as ModelRecord;
}

test("picking a tier never makes the mapping decrease from simple to complex", () => {
  const start: TierTargets[] = [
    { simple: "small", standard: "small", complex: "small" },
    { simple: "small", standard: "small", complex: "medium" },
    { simple: "frontier", standard: "frontier", complex: "frontier" },
  ];
  for (const base of start) {
    for (const difficulty of DIFFICULTIES) {
      for (const tier of RATED_TIERS) {
        const next = adjustTier(base, difficulty, tier);
        expect(TIERS[next.simple]).toBeLessThanOrEqual(TIERS[next.standard]);
        expect(TIERS[next.standard]).toBeLessThanOrEqual(TIERS[next.complex]);
      }
    }
  }
});

test("adjustTier lowers earlier rows and raises later rows around the picked cell", () => {
  // Simple → Frontier raises standard and complex to frontier too.
  expect(adjustTier(balanced, "simple", "frontier")).toEqual({ simple: "frontier", standard: "frontier", complex: "frontier" });
  // Standard → Small keeps simple at small and complex at frontier.
  expect(adjustTier(balanced, "standard", "small")).toEqual({ simple: "small", standard: "small", complex: "frontier" });
  // Complex → Small keeps the earlier rows at most small.
  expect(adjustTier(balanced, "complex", "small")).toEqual({ simple: "small", standard: "small", complex: "small" });
  // Simple → Medium keeps later rows at least medium.
  expect(adjustTier({ simple: "small", standard: "small", complex: "small" }, "simple", "medium")).toEqual({ simple: "medium", standard: "medium", complex: "medium" });
});

test("presets produce the documented mappings and 'Custom' when nothing matches", () => {
  expect(PRESETS.economical).toEqual({ simple: "small", standard: "small", complex: "medium" });
  expect(PRESETS.balanced).toEqual({ simple: "small", standard: "medium", complex: "frontier" });
  expect(PRESETS.quality).toEqual({ simple: "medium", standard: "frontier", complex: "frontier" });
  expect(PRESETS.frontier).toEqual({ simple: "frontier", standard: "frontier", complex: "frontier" });
  expect(PRESET_LABELS.frontier).toBe("Frontier only");
  expect(matchingPreset(PRESETS.balanced)).toBe("balanced");
  expect(matchingPreset({ simple: "small", standard: "small", complex: "small" })).toBe("custom");
  expect(applyPreset(balanced, "economical")).toEqual(PRESETS.economical);
});

test("steeredCount counts executors with at least one rated exact model", () => {
  const records = [
    model("opencode", { binding: { kind: "exact", id: "qwen" }, tier: "small" }),
    model("codex", { binding: { kind: "exact", id: "gpt" }, tier: "unknown" }),
    model("claude-code"),
  ];
  expect(steeredCount(records)).toEqual({ steered: 1, total: 3 });
});

test("groupPreview buckets executors by behavior and reports eligible counts per difficulty", () => {
  const records = [
    model("opencode", { binding: { kind: "exact", id: "qwen3.6-35b-a3b" }, tier: "small" }),
    model("cursor", { binding: { kind: "exact", id: "auto" }, tier: "medium" }),
    model("codex", { binding: { kind: "exact", id: "gpt-5" }, tier: "unknown" }),
    model("claude-code"),
  ];
  const grouping = groupPreview(records, balanced);
  expect(grouping.steered).toBe(2);
  expect(grouping.total).toBe(4);
  expect(grouping.follow.map(row => row.runner)).toEqual(["opencode", "cursor"]);
  expect(grouping.follow.map(row => row.tier)).toEqual(["small", "medium"]);
  expect(grouping.unrated.map(row => row.runner)).toEqual(["codex"]);
  expect(grouping.unrated[0]!.model).toBe("gpt-5");
  expect(grouping.fixed.map(row => row.runner)).toEqual(["claude-code"]);
  // opencode (small): used for simple, not used for standard or complex
  const opencode = grouping.follow[0]!;
  expect(opencode.cells.map(c => c.skipped)).toEqual([false, true, true]);
  expect(opencode.cells[0]!.note).toBe("Matches the target");
  expect(opencode.cells[1]!.note).toBe("Model is smaller than the target");
  // cursor (medium): upward fallback for simple, match for standard, not used for complex
  const cursor = grouping.follow[1]!;
  expect(cursor.cells[0]!.chosen).toBe("auto");
  expect(cursor.cells[0]!.note).toBe("Larger than needed, used when nothing smaller is free");
  expect(cursor.cells[1]!.note).toBe("Matches the target");
  expect(cursor.cells[2]!.skipped).toBe(true);
  // eligible: everyone can take simple, unrated and fixed can take anything
  expect(grouping.cols.map(col => col.eligible)).toEqual([4, 3, 2]);
  expect(grouping.cols.map(col => col.target)).toEqual(["small", "medium", "frontier"]);
});

test("groupPreview follow cells use selectModel exactly as the dispatcher does", () => {
  const records = [
    model("opencode", { binding: { kind: "exact", id: "qwen" }, tier: "small" }),
    model("opencode", { binding: { kind: "exact", id: "glm" }, tier: "frontier" }),
  ];
  const grouping = groupPreview(records, balanced);
  const row = grouping.follow[0]!;
  // Complex targets frontier; the frontier model is chosen and matches.
  expect(row.cells[2]!.chosen).toBe("glm");
  expect(row.cells[2]!.skipped).toBe(false);
  expect(row.cells[2]!.note).toBe("Matches the target");
});

test("unrated group previews its single model for every difficulty", () => {
  const records = [model("codex", { binding: { kind: "exact", id: "gpt-5" }, tier: "unknown" })];
  const grouping = groupPreview(records, balanced);
  expect(grouping.follow).toEqual([]);
  expect(grouping.unrated).toEqual([{ runner: "codex", model: "gpt-5" }]);
  expect(grouping.cols.map(col => col.eligible)).toEqual([1, 1, 1]);
});

test("adjustTier with a rated tier argument type guards the whole space", () => {
  const tier: RatedTier = "medium";
  const next = adjustTier(balanced, "complex", tier);
  expect(next.complex).toBe("medium");
  // earlier rows stay at most medium; nothing increases.
  expect(TIERS[next.simple]).toBeLessThanOrEqual(TIERS.medium);
  expect(TIERS[next.standard]).toBeLessThanOrEqual(TIERS.medium);
  expect(TIERS[next.complex]).toBe(TIERS.medium);
});