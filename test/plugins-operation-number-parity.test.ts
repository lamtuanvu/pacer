import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPluginSettings } from "../src/plugins/settings";
import { tmpDir } from "./helpers";
import { expect, test } from "bun:test";
import cases from "./fixtures/plugin-operation-number-parity.json";
import { validateSettings } from "../src/plugins/settings";
import { OPS } from "../src/api/ops";
import { uiRenderResult, viewNodeSchema } from "../src/plugins/ui-schema";

for (const row of cases) test(`plugin number parity: ${row.field}=${row.wire}`, () => {
  const value = JSON.parse(row.wire);
  if (row.field === "storedRev") {
    const pacerHome = tmpDir();
    writeFileSync(join(pacerHome, "plugin-settings.json"), `{"fx-ui":{"rev":${row.wire},"values":{"required":true},"hidden":[]}}`);
    const record = readPluginSettings({ pacerHome }, "fx-ui");
    expect(JSON.stringify(record.rev)).toBe(row.normalized!);
    expect(record.values).toEqual(row.accepted ? { required: true } : {});
  } else if (row.field === "settingsInteger") {
    const schema = { fields: { Budget: { type: "integer" as const, title: "Budget", minimum: row.minimum!, maximum: row.maximum! } } };
    expect(validateSettings(schema, { Budget: value })).toEqual(row.accepted ? [] : [{ path: "Budget", message: row.error! }]);
  } else if (row.field === "actionScalar") {
    if (row.accepted) expect(JSON.stringify(value)).toBe(row.normalized!);
    expect(OPS["plugin.ui.action"].params.safeParse({ plugin: "fx-ui", surface: "activity", id: "checklist", action: "run", requestId: "matrix", context: { route: "overview", theme: "light" }, values: { Budget: value } }).success).toBe(row.accepted);
  } else if (row.field === "expect_rev") {
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
