import { expect, test } from "bun:test";
import { dispatchConfigSchema, type ModelRecord } from "../src/dispatch/types";
import { selectModel, targetTier, tierBuckets, type Difficulty, type TierReason } from "../src/dispatch/tier-select";

const targets = dispatchConfigSchema.parse({}).tierTargets;
const model = (id: string, tier: ModelRecord["tier"]): ModelRecord => ({
  runner: "runner", account: "account", executor: "opencode", binding: { kind: "exact", id },
  actualModel: null, tier, strengths: [], provenance: "declared",
});
const small = model("provider/small", "small");
const medium = model("provider/medium", "medium");
const frontier = model("provider/frontier", "frontier");
const unknown = model("provider/unknown", "unknown");
const fallback: ModelRecord = { ...small, binding: { kind: "executor-default" } };

test.each([
  ["simple", "small"], ["standard", "medium"], ["complex", "frontier"],
] as const)("%s maps to %s", (difficulty, tier) => {
  expect(targetTier(difficulty, targets)).toBe(tier);
});

test("minimum tier raises the target without lowering it", () => {
  expect(targetTier("simple", targets, "medium")).toBe("medium");
  expect(targetTier("complex", targets, "small")).toBe("frontier");
  expect(targetTier("simple", { ...targets, simple: "medium" })).toBe("medium");
});

test("buckets preserve input order and put unknown last without mutating input", () => {
  const second = model("second", "medium");
  const records = [frontier, medium, small, unknown, second];
  expect(tierBuckets(records, "medium")).toEqual([[medium, second], [frontier], [unknown]]);
  expect(records).toEqual([frontier, medium, small, unknown, second]);
});

type Options = Parameters<typeof selectModel>[1];
const cases: { name: string; records: ModelRecord[]; options?: Partial<Options>; chosen: ModelRecord | null; reason: TierReason }[] = [
  { name: "small beats frontier", records: [frontier, small], chosen: small, reason: "target-match" },
  { name: "unusable target falls upward", records: [small, frontier], options: { isUsable: r => r !== small }, chosen: frontier, reason: "upward-fallback" },
  { name: "nearest upward tier wins", records: [frontier, medium], chosen: medium, reason: "upward-fallback" },
  { name: "unknown last resort", records: [unknown], chosen: unknown, reason: "unknown-tier-fallback" },
  { name: "minimum excludes unknown", records: [unknown], options: { minTier: "small" }, chosen: null, reason: "target-match" },
  { name: "pin overrides difficulty", records: [small, frontier], options: { difficulty: "complex", pin: "provider/small" }, chosen: small, reason: "explicit-override" },
  { name: "missing pin does not fall back", records: [small], options: { pin: "missing" }, chosen: null, reason: "explicit-override" },
  { name: "unusable pin does not fall back", records: [small, frontier], options: { pin: "provider/small", isUsable: r => r !== small }, chosen: null, reason: "explicit-override" },
  { name: "minimum excludes pinned unknown", records: [unknown], options: { pin: "provider/unknown", minTier: "small" }, chosen: null, reason: "explicit-override" },
  { name: "fixed exact default preferred", records: [fallback, small], options: { difficulty: "complex", fixedExecutor: true, defaultModel: "provider/small" }, chosen: small, reason: "executor-fixed-below-target" },
  { name: "fixed binding fallback", records: [small, fallback], options: { difficulty: "complex", fixedExecutor: true, defaultModel: "missing" }, chosen: fallback, reason: "executor-fixed-below-target" },
  { name: "fixed without default is null", records: [small], options: { difficulty: "complex", fixedExecutor: true }, chosen: null, reason: "executor-fixed-below-target" },
  { name: "fixed respects usability", records: [small, fallback], options: { difficulty: "complex", fixedExecutor: true, defaultModel: "provider/small", isUsable: r => r !== small }, chosen: fallback, reason: "executor-fixed-below-target" },
  { name: "fixed does not bypass minimum", records: [small, fallback], options: { difficulty: "complex", fixedExecutor: true, defaultModel: "provider/small", minTier: "medium" }, chosen: null, reason: "executor-fixed-below-target" },
  { name: "fixed prefers eligible target", records: [small, frontier], options: { difficulty: "complex", fixedExecutor: true, defaultModel: "provider/small" }, chosen: frontier, reason: "target-match" },
  { name: "normal does not fall below target", records: [small], options: { difficulty: "complex" }, chosen: null, reason: "target-match" },
  { name: "empty inventory", records: [], chosen: null, reason: "target-match" },
  { name: "deterministic within bucket", records: [small, model("other", "small")], chosen: small, reason: "target-match" },
];
for (const c of cases) test(c.name, () => {
  const options = { difficulty: "simple" as Difficulty, targets, ...c.options };
  expect(selectModel(c.records, options)).toEqual({
    record: c.chosen, selectedTier: c.chosen?.tier ?? null,
    targetTier: targetTier(options.difficulty, targets, options.minTier), reason: c.reason,
  });
});
