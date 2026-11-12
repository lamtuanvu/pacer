import { expect, test } from "bun:test";
import { mergeRows, takesFor, toggleModel, buildSavePlan, isDirty, formatPrice, formatContext, formatTools, defaultForRows } from "../app/src/model/model-matrix";

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
  const plan = buildSavePlan([{ runner: "r", revision: "v1", baseRows: rows, rows: rows, default: "a" }], { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan.changed).toBe(false);
  const changedRows = [{ ...rows[0], tier: "medium" }];
  const plan2 = buildSavePlan([{ runner: "r", revision: "v1", baseRows: rows, rows: changedRows, default: "a" }], { simple: "small", standard: "medium", complex: "frontier" } as any, "v1");
  expect(plan2.changed).toBe(true);
  expect(plan2.changedRunners).toEqual(["r"]);
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
