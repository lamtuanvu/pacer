import { test, expect } from "bun:test";
import cases from "./fixtures/plugin-manifest-parity.json";
import { manifestSchema, uiOf } from "../src/plugins/protocol";

for (const item of cases) {
  test(`manifest parity: ${item.name}`, () => {
    const parsed = manifestSchema.safeParse(item.manifest);
    expect(parsed.success).toBe(item.accepted);
    if (!parsed.success) return;
    if ("normalizedTitle" in item) expect(uiOf(parsed.data)?.status[0]?.title).toBe(item.normalizedTitle);
    if (typeof item.strippedTopLevel === "string") expect(Object.hasOwn(parsed.data, item.strippedTopLevel)).toBe(false);
  });
}
