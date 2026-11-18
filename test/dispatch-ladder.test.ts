import { expect, test } from "bun:test";
import { evaluateLadder } from "../src/dispatch/ladder";
import { buildCandidates } from "../src/dispatch/candidates";
import { validateStrategy } from "../src/config/strategy";
import { candidate, request } from "./fixtures/dispatch";
import type { ModelRecord, Observation } from "../src/dispatch/types";

test("ladder skips a specialist near its limit then chooses capable spare capacity", () => {
  const r = request();
  r.config.steps.unshift({ ...r.config.steps[0], id: "specialist", candidates: { models: ["provider/b"] } });
  const result = evaluateLadder(r, r.config);
  expect(result.state).toBe("ranked");
  if (result.state === "ranked") { expect(result.choices.map(c => c.id)).toEqual(["a"]); expect(result.skipped).toEqual(["specialist"]); }
  r.config.steps[0].capacity = "usable";
  expect(evaluateLadder(r, r.config)).toMatchObject({ step: "specialist", choices: [{ id: "b" }] });
});
test("requirements, pins, generic kind matching and stable tie breaks survive fallback", () => {
  const r = request([candidate("z"), candidate("a")]);
  expect(evaluateLadder(r, r.config)).toMatchObject({ choices: [{ id: "a" }, { id: "z" }] });
  r.task.requirements.minTier = "frontier";
  expect(evaluateLadder(r, r.config).state).toBe("no-match");
  r.task.requirements = {};
  r.task.model = "absent";
  expect(evaluateLadder(r, r.config).state).toBe("no-match");
  delete r.task.model;
  r.config.steps.unshift({ ...r.config.steps[0], id: "kind-specific", match: { kind: "debug" } });
  expect(evaluateLadder(r, r.config)).toMatchObject({ step: "capable-with-headroom", skipped: ["kind-specific"] });
});
test("unknown model cannot satisfy required capabilities and unknown capacity needs explicit step", () => {
  const c = candidate("a", null); c.tier = "unknown"; delete c.tools;
  const r = request([c]);
  expect(evaluateLadder(r, r.config).state).toBe("no-match");
  r.config.steps[0].capacity = "unknown";
  expect(evaluateLadder(r, r.config).state).toBe("ranked");
  r.task.requirements.tools = true;
  expect(evaluateLadder(r, r.config).state).toBe("no-match");
});
test("candidate capacity uses every quota window without adding shared balances", () => {
  const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "test");
  const models: ModelRecord[] = ["a", "b"].map(id => ({ ...candidate(id), runner: "codex", account: "codex" }));
  const o: Observation[] = [{ source: "test", scope: { runner: "codex", account: "codex" }, method: "health", state: "known", observedAt: 90, expiresAt: 110, value: { healthy: true } }, { source: "test", scope: { runner: "codex", account: "codex" }, method: "usage", state: "known", observedAt: 90, expiresAt: 110, value: { windows: [{ pool: "weekly", usedPct: 10 }, { pool: "daily", usedPct: 95 }] } }];
  const result = buildCandidates(s, request().task, models, o, 100);
  expect(result.candidates.map(c => c.headroom)).toEqual([5, 5]);
  expect(result.candidates.map(c => c.poolIds)).toEqual([["daily", "weekly"], ["daily", "weekly"]]);
  expect(buildCandidates(s, request().task, models, o, 120).candidates.every(c => !c.capacityKnown)).toBe(true);
});
test("model-specific quota exhaustion cannot block another model", () => {
  const s = validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}}}, "test");
  const models = ["a", "b"].map(id => ({ ...candidate(id), runner: "codex", account: "codex" }));
  const result = buildCandidates(s, request().task, models, [{source: "test", scope: {runner: "codex", account: "codex", binding: {kind: "exact", id: "provider/a"}}, method: "usage", state: "known", observedAt: 90, expiresAt: 110, value: {windows: [{pool: "a-only", usedPct: 100}]}}], 100);
  expect(result.candidates.map(c => c.binding)).toEqual([{kind: "exact", id: "provider/b"}]);
  expect(result.candidates[0].capacityKnown).toBe(false);
});

test("simple work prefers a usable small over a comfortable frontier", () => {
  const r = request([{ ...candidate("small", 10), tier: "small" }, { ...candidate("frontier", 90), tier: "frontier" }]);
  r.task.difficulty = "simple";
  expect(evaluateLadder(r, r.config)).toMatchObject({
    state: "ranked", step: "usable-fallback", choices: [{ id: "small" }],
    tier: { targetTier: "small", selectedTier: "small", reason: "target-match" },
  });
});

test("no usable small falls back upward and says so", () => {
  const r = request([{ ...candidate("small", 0), tier: "small" }, candidate("medium", 10), { ...candidate("frontier", 90), tier: "frontier" }]);
  r.task.difficulty = "simple";
  expect(evaluateLadder(r, r.config)).toMatchObject({
    choices: [{ id: "medium" }], tier: { targetTier: "small", selectedTier: "medium", reason: "upward-fallback" },
  });
});

test("preferences cannot cross tier buckets", () => {
  const r = request([candidate("medium"), { ...candidate("frontier"), tier: "frontier", learnedFit: { successRate: 1, uncertainty: 0, sampleCount: 100 } }]);
  r.task.preferences.models = ["provider/frontier"];
  r.config.steps[0].prefer.models = ["provider/frontier"];
  expect(evaluateLadder(r, r.config)).toMatchObject({ choices: [{ id: "medium" }], tier: { reason: "target-match" } });
});

test("all-unknown inventory still routes, labelled unknown-tier-fallback", () => {
  const r = request([{ ...candidate("unknown"), tier: "unknown" }]);
  expect(evaluateLadder(r, r.config)).toMatchObject({
    choices: [{ id: "unknown" }], tier: { targetTier: "medium", selectedTier: "unknown", reason: "unknown-tier-fallback" },
  });
});

test("model pins override target tiers but still obey hard requirements", () => {
  const r = request([{ ...candidate("small"), tier: "small" }, { ...candidate("frontier"), tier: "frontier" }]);
  r.task.difficulty = "complex";
  r.task.model = "provider/small";
  expect(evaluateLadder(r, r.config)).toMatchObject({
    choices: [{ id: "small" }], tier: { targetTier: "frontier", selectedTier: "small", reason: "explicit-override" },
  });
  r.task.requirements.minTier = "medium";
  expect(evaluateLadder(r, r.config).state).toBe("no-match");
});

test("custom target tiers and minimum requirements set the bucket floor", () => {
  const r = request([candidate("medium"), { ...candidate("frontier"), tier: "frontier" }]);
  r.config.tierTargets.standard = "frontier";
  expect(evaluateLadder(r, r.config)).toMatchObject({ choices: [{ id: "frontier" }], tier: { targetTier: "frontier" } });
  r.task.difficulty = "simple";
  r.task.requirements.minTier = "frontier";
  expect(evaluateLadder(r, r.config)).toMatchObject({ choices: [{ id: "frontier" }], tier: { targetTier: "frontier" } });
});
