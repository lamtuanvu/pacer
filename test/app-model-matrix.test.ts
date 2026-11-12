import { expect, test } from "bun:test";
import { mergeRows, takesFor, toggleModel, buildSavePlan, isDirty, formatPrice, formatContext, formatTools, defaultForRows, suggestRow, acceptAllSuggestions, setTier, rebaseSavedDrafts } from "../app/src/model/model-matrix";
import type { RunnerModels } from "../src/core/runner-models";

test("mergeRows unions listing and declared models", () => {
  const rows = mergeRows([{ id: "a", context: 10, tools: true, costOut: 1 }], [{ id: "a", tier: "small" }, { id: "b", tier: "medium" }]);
  expect(rows.map(r => r.id).sort()).toEqual(["a", "b"]);
  const a = rows.find(r => r.id === "a")!;
  expect(a.on).toBe(true);
  expect(a.tier).toBe("small");
  expect(a.context).toBe(10);
  const b = rows.find(r => r.id === "b")!;
  expect(b.on).toBe(true);
  expect(b.tier).toBe("medium");
});

test("takesFor compares tier to targets", () => {
  const targets = { simple: "small", standard: "medium", complex: "frontier" } as any;
  expect(takesFor("medium", targets)).toEqual(["simple", "standard"]);
});

test("toggleModel moves default when turned off", () => {
  const rows = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [] }, { id: "b", on: true, tier: "medium", isDefault: false, takes: [] }] as any;
  const result = toggleModel(rows, "a", false, "a");
  expect(result.default).toBe("b");
});

test("buildSavePlan only includes changed runners", () => {
  const rows = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [] }] as any;
  const plan = buildSavePlan([{ runner: "r", revision: "v1", baseRows: rows, rows: rows, default: "a", baseDefault: "a" }], { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan.changed).toBe(false);
  const changedRows = [{ ...rows[0], tier: "medium" }];
  const plan2 = buildSavePlan([{ runner: "r", revision: "v1", baseRows: rows, rows: changedRows, default: "a", baseDefault: "a" }], { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan2.changed).toBe(true);
  expect(plan2.changedRunners).toEqual(["r"]);
});

test("buildSavePlan compares against the loaded default, not row flags (stale default is untouched)", () => {
  // The loaded default "gpt-5" is not a row (stale default); nothing changed, so the runner is not saved.
  const baseRows = [{ id: "a", on: true, tier: "small", isDefault: false, takes: [] }] as any;
  const plan = buildSavePlan(
    [{ runner: "x", revision: "v1", baseRows, rows: baseRows, default: "gpt-5", baseDefault: "gpt-5" }],
    { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan.changed).toBe(false);
  // If the draft default differs from the loaded one, the runner is sent.
  const plan2 = buildSavePlan(
    [{ runner: "x", revision: "v1", baseRows, rows: baseRows, default: "other", baseDefault: "gpt-5" }],
    { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan2.changed).toBe(true);
  expect(plan2.changedRunners).toEqual(["x"]);
});

test("buildSavePlan leaves an untouched planner and unrelated runners out", () => {
  const plannerRows = [{ id: "default-model", on: true, tier: "small", isDefault: true, takes: [] }] as any;
  const otherRows = [{ id: "m", on: true, tier: "medium", isDefault: true, takes: [] }] as any;
  const editing = [{ ...otherRows[0], tier: "frontier" }];
  const plan = buildSavePlan([
    { runner: "claude-code", revision: "v1", baseRows: plannerRows, rows: plannerRows, default: "default-model", baseDefault: "default-model" },
    { runner: "other", revision: "v1", baseRows: otherRows, rows: otherRows, default: "m", baseDefault: "m" },
    { runner: "edited", revision: "v1", baseRows: otherRows, rows: editing, default: "m", baseDefault: "m" },
  ], { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan.changedRunners).toEqual(["edited"]);
});

test("saving a declared model keeps its strengths, tools and context", () => {
  const declared = { id: "a", tier: "small", strengths: ["docs"], tools: true, context: 200000 };
  const baseRows = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [], declared }] as any;
  const rows = [{ ...baseRows[0], tier: "medium" }];
  const plan = buildSavePlan(
    [{ runner: "r", revision: "v1", baseRows, rows, default: "a", baseDefault: "a" }],
    { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan.runners).toEqual([
    { id: "r", default: "a", models: [{ id: "a", tier: "medium", strengths: ["docs"], tools: true, context: 200000 }] },
  ]);
  // A model added on screen (no declared metadata) is written as id + tier only.
  const addedRow = { id: "new-model", on: true, tier: "unknown", isDefault: false, takes: [] } as any;
  const plan2 = buildSavePlan(
    [{ runner: "r", revision: "v1", baseRows: [addedRow], rows: [addedRow], default: "new-model", baseDefault: null }],
    { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan2.runners).toEqual([{ id: "r", default: "new-model", models: [{ id: "new-model", tier: "unknown" }] }]);
});

test("isDirty ignores suggestion fields", () => {
  const base = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [], suggestedOn: undefined, suggestedTier: undefined, pending: false }] as any;
  const withSuggestion = [{ ...base[0], suggestedOn: false, suggestedTier: "medium", pending: true, suggestionReason: "x" }] as any;
  expect(isDirty(withSuggestion, base)).toBe(false);
});

test("toggleModel default rules", () => {
  const rows = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [] }, { id: "b", on: true, tier: "medium", isDefault: false, takes: [] }] as any;
  // turn default off moves default to first enabled
  const r1 = toggleModel(rows, "a", false, "a");
  expect(r1.default).toBe("b");
  // all off => default unchanged
  const rows2 = [{ id: "a", on: true, tier: "small", isDefault: true, takes: [] }] as any;
  const r2 = toggleModel(rows2, "a", false, "a");
  expect(r2.default).toBe("a");
  // no default and every off stays null-ish
  const rows3 = [{ id: "a", on: true, tier: "small", isDefault: false, takes: [] }] as any;
  const r3 = toggleModel(rows3, "a", false, null);
  expect(r3.default).toBeNull();
});

test("defaultForRows handles missing default", () => {
  const rows = [{ id: "a", on: false, tier: "small", isDefault: false, takes: [] }] as any;
  expect(defaultForRows(rows, null)).toBeNull();
  const rows2 = [{ id: "a", on: true, tier: "small", isDefault: false, takes: [] }] as any;
  expect(defaultForRows(rows2, null)).toBe("a");
});

test("formatPrice formats costOut", () => {
  expect(formatPrice(1.234)).toBe("$1.23/M");
  expect(formatPrice(5)).toBe("$5/M");
  expect(formatPrice(null)).toBe("—");
  expect(formatPrice(undefined)).toBe("—");
});

test("formatContext formats counts", () => {
  expect(formatContext(200000)).toBe("200K");
  expect(formatContext(1000000)).toBe("1M");
  expect(formatContext(undefined)).toBe("—");
});

test("formatTools formats support", () => {
  expect(formatTools(true)).toBe("Yes");
  expect(formatTools(false)).toBe("No");
  expect(formatTools(null)).toBe("—");
  expect(formatTools(undefined)).toBe("—");
});

test("suggest does not turn off enabled models that have no listing facts", () => {
  // Unknown listing (source: none): no entry at all.
  const onUnknown = { id: "a", on: true, tier: "small", isDefault: true, takes: [], pending: false } as any;
  const suggested = suggestRow(onUnknown, undefined);
  expect(suggested.suggestedOn).toBeUndefined();
  expect(suggested.pending).toBe(false);
  expect(acceptAllSuggestions([onUnknown])[0]!.on).toBe(true);
  // Connection-only listing: price (costOut) absent, no facts to act on.
  const onConnection = { id: "a", on: true, tier: "small", isDefault: true, takes: [], pending: false } as any;
  const connRow = suggestRow(onConnection, { id: "a", tools: true });
  expect(connRow.pending).toBe(false);
  expect(acceptAllSuggestions([onConnection])[0]!.on).toBe(true);
});

test("suggest proposes on only from listing facts and still allows turning off a rated model", () => {
  const off = { id: "a", on: false, tier: "small", isDefault: false, takes: [], pending: false } as any;
  const suggested = suggestRow(off, { id: "a", tools: true, costOut: 0.5 });
  expect(suggested.suggestedOn).toBe(true);
  expect(suggested.pending).toBe(true);
  expect(acceptAllSuggestions([suggested])[0]!.on).toBe(true);
  // A model with a price but no tool support is proposed off, for executors that both allow tools.
  const onNoTools = { id: "b", on: true, tier: "medium", isDefault: true, takes: [], pending: false } as any;
  const offSuggestion = suggestRow(onNoTools, { id: "b", tools: false, costOut: 5 });
  expect(offSuggestion.suggestedOn).toBe(false);
  expect(offSuggestion.pending).toBe(true);
});

test("setTier can return a model to unrated", () => {
  const rows = [{ id: "a", on: true, tier: "medium", isDefault: true, takes: [], pending: false } as any];
  const next = setTier(rows, "a", "unknown");
  expect(next[0]!.tier).toBe("unknown");
});

const draftOf = (runner: string, tier = "small", revision = "v1") => ({
  runner,
  revision,
  default: "a",
  rows: [{ id: "a", on: true, tier, isDefault: true, takes: [], declared: { id: "a", tier } } as any],
  baseRows: [{ id: "a", on: true, tier: "small", isDefault: true, takes: [] } as any],
  addedIds: [],
});

test("rebaseSavedDrafts folds the save result only into unchanged planned runners (G3)", () => {
  const returned = new Map<string, RunnerModels>([
    ["changed", { runner: "changed", revision: "r9", default: "b", models: [{ id: "a", tier: "medium", strengths: ["docs"], tools: true, context: 128 }] }],
    ["edited", { runner: "edited", revision: "r9", default: "b", models: [] }],
  ]);
  const out = rebaseSavedDrafts(
    [draftOf("changed"), draftOf("edited"), draftOf("untouched")],
    ["changed", "edited"],
    runner => runner === "edited" ? 2 : 0, // edited again while the save ran
    runner => runner === "edited" ? 1 : 0, // version when the save began
    returned,
    "r9",
  );
  // changed was untouched during the save: rebased onto the returned server
  // state (new revision, default and declared metadata) and clean.
  const changed = out.find(d => d.runner === "changed")!;
  expect(changed.revision).toBe("r9");
  expect(changed.default).toBe("b");
  expect(changed.rows[0]!.declared).toMatchObject({ id: "a", tier: "medium", strengths: ["docs"], tools: true, context: 128 });
  expect(JSON.stringify(changed.baseRows)).toBe(JSON.stringify(changed.rows));
  // edited bumped its version during the save: kept as-is, still dirty.
  const edited = out.find(d => d.runner === "edited")!;
  expect(edited.revision).toBe("v1");
  expect(edited.default).toBe("a");
  // untouched and any runner without a server return stay put.
  const untouched = out.find(d => d.runner === "untouched")!;
  expect(untouched.revision).toBe("v1");
  expect(untouched.rows[0]!.tier).toBe("small");
});

test("rebaseSavedDrafts leaves dirty edits that happened during the save untouched", () => {
  const base = draftOf("r", "small");
  const returned = new Map<string, RunnerModels>([["r", { runner: "r", revision: "r9", default: "b", models: [] }]]);
  // The runner was part of the plan but its version moved (edited) mid-flight.
  const out = rebaseSavedDrafts([base], ["r"], () => 5, () => 4, returned, "r9");
  expect(out[0]).toBe(base);
  expect(out[0]!.revision).toBe("v1");
});
