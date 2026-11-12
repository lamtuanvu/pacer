import { expect, test } from "bun:test";
import { mergeRows, takesFor, toggleModel, buildSavePlan, isDirty } from "../app/src/model/model-matrix";

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
