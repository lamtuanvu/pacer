import { expect, test } from "bun:test";
import type { ModelRecord, TierTargets } from "../src/dispatch/types";
import { TIERS } from "../src/dispatch/candidates";
import {
  adjustTier, applyPreset, matchingPreset, PRESETS, PRESET_LABELS, steeredCount, groupPreview,
  unsteeredCopy, DIFFICULTIES, RATED_TIERS, type RatedTier,
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
  // opencode (small): only simple matches; standard and complex are below it,
  // and with no unrated model automatic dispatch skips it there.
  const opencode = grouping.follow[0]!;
  expect(opencode.cells.map(c => c.skipped)).toEqual([false, true, true]);
  expect(opencode.cells[0]!.note).toBe("Matches the target");
  expect(opencode.cells[1]!.chosen).toBe("Skipped by automatic dispatch");
  expect(opencode.cells[1]!.note).toBe("Runs its default if picked directly");
  // cursor (medium): upward fallback for simple, match for standard, and below
  // complex (frontier) automatic dispatch skips it (no unrated model).
  const cursor = grouping.follow[1]!;
  expect(cursor.cells[0]!.chosen).toBe("auto");
  expect(cursor.cells[0]!.note).toBe("Larger than needed, used when nothing smaller is free");
  expect(cursor.cells[1]!.note).toBe("Matches the target");
  expect(cursor.cells[2]!.chosen).toBe("Skipped by automatic dispatch");
  expect(cursor.cells[2]!.note).toBe("Runs its default if picked directly");
  expect(cursor.cells[2]!.skipped).toBe(true);
  // eligible: automatic dispatch can route simple to all four (each has a rated
  // model at/above small or an unrated model); standard needs at least medium
  // (codex and claude-code count as unrated-ish); complex needs frontier-sized
  // or unrated, leaving opencode and cursor out (H2).
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

test("a follow executor with only below-target models is skipped by automatic dispatch (H2)", () => {
  // A follow runner whose only model is small, when the standard and complex
  // targets are medium and frontier, is not an automatic-dispatch candidate
  // for those: the cell says so and notes it runs its default if picked
  // directly (matching plain delegation), rather than claiming it can take
  // the difficulty.
  const records = [
    model("opencode", { binding: { kind: "exact", id: "opencode/fast" }, tier: "small" }),
  ];
  const grouping = groupPreview(records, balanced, { opencode: "opencode/fast" });
  const row = grouping.follow[0]!;
  expect(row.cells[0]!.chosen).toBe("fast");
  expect(row.cells[0]!.skipped).toBe(false);
  // Standard and complex target medium and frontier; the small-only runner is
  // skipped by automatic dispatch there and runs its default if picked directly.
  expect(row.cells[1]!.chosen).toBe("Skipped by automatic dispatch");
  expect(row.cells[1]!.note).toBe("Runs its default if picked directly");
  expect(row.cells[1]!.skipped).toBe(true);
  expect(row.cells[2]!.chosen).toBe("Skipped by automatic dispatch");
  expect(row.cells[2]!.skipped).toBe(true);
});

test("groupPreview uses an executor's configured default id as the fallback model", () => {
  const records = [
    model("opencode", { binding: { kind: "exact", id: "provider/small" }, tier: "small" }),
    model("opencode", { binding: { kind: "exact", id: "provider/fallback" }, tier: "unknown" }),
  ];
  const grouping = groupPreview(records, balanced, { opencode: "provider/fallback" });
  const row = grouping.follow[0]!;
  expect(row.cells[1]!.skipped).toBe(false);
  expect(row.cells[1]!.chosen).toBe("fallback");
});

test("a follow runner with all models below the target is skipped, not 'Not used' (H2)", () => {
  // Automatic dispatch does not route a runner whose rated models are all below
  // the target, so the cell shows that a below-target difficulty skips it and
  // it runs its default only if picked directly; no "Not used", no claim it
  // can take the difficulty.
  const records = [model("opencode", { binding: { kind: "exact", id: "provider/small" }, tier: "small" })];
  const pairing = groupPreview(records, balanced, {});
  const row = pairing.follow[0]!;
  expect(row.cells.map(c => c.skipped)).toEqual([false, true, true]);
  expect(row.cells[1]!.chosen).toBe("Skipped by automatic dispatch");
  expect(row.cells[2]!.chosen).toBe("Skipped by automatic dispatch");
  expect(row.cells[2]!.note).toBe("Runs its default if picked directly");
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

test("unsteeredCopy keeps correct agreement and never prints a zero clause", () => {
  expect(unsteeredCopy(1, 1))
    .toBe("1 executor runs a model nobody has rated, and 1 executor picks its own model, so every task gets the same model whatever its difficulty.");
  expect(unsteeredCopy(2, 1))
    .toBe("2 executors run models nobody has rated, and 1 executor picks its own model, so every task gets the same model whatever its difficulty.");
  expect(unsteeredCopy(1, 2))
    .toBe("1 executor runs a model nobody has rated, and 2 executors pick their own model, so every task gets the same model whatever its difficulty.");
  // Zero groups are dropped entirely, leaving only the non-empty part.
  expect(unsteeredCopy(0, 2))
    .toBe("2 executors pick their own model, so every task gets the same model whatever its difficulty.");
  expect(unsteeredCopy(2, 0))
    .toBe("2 executors run models nobody has rated, so every task gets the same model whatever its difficulty.");
  expect(unsteeredCopy(1, 0))
    .toBe("1 executor runs a model nobody has rated, so every task gets the same model whatever its difficulty.");
  expect(unsteeredCopy(0, 0)).toBe("");
});