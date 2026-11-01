import { test, expect } from "bun:test";
import cases from "./fixtures/plugin-manifest-parity.json";
import { manifestSchema } from "../src/plugins/protocol";

for (const item of cases) {
  test(`manifest parity: ${item.name}`, () => {
    expect(manifestSchema.safeParse(item.manifest).success).toBe(item.accepted);
  });
}
