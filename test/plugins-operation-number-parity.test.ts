import { expect, test } from "bun:test";
import cases from "./fixtures/plugin-operation-number-parity.json";
import { OPS } from "../src/api/ops";
import { uiRenderResult, viewNodeSchema } from "../src/plugins/ui-schema";

for (const row of cases) test(`plugin number parity: ${row.field}=${row.wire}`, () => {
  const value = JSON.parse(row.wire);
  if (row.field === "expect_rev") {
    for (const [name, params] of [
      ["plugin.settings.set", { plugin: "fx-ui", values: {}, expect_rev: value }],
      ["plugin.ui.visibility", { plugin: "fx-ui", surface: "activity", id: "checklist", visible: true, expect_rev: value }],
    ] as const) expect(OPS[name].params.safeParse(params).success).toBe(row.accepted);
  } else if (row.field === "ttlS") {
    expect(uiRenderResult.safeParse({ document: { type: "text", text: "Ready" }, ttlS: value }).success).toBe(row.accepted);
  } else {
    const node = row.field === "level" ? { type: "heading", text: "Ready", level: value }
      : { type: "meter", label: "Ready", usedPct: 50, [row.field]: value };
    expect(viewNodeSchema.safeParse(node).success).toBe(row.accepted);
  }
});
