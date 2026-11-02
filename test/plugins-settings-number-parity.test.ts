import { expect, test } from "bun:test";
import cases from "./fixtures/plugin-settings-number-parity.json";
import { settingsSchemaSchema } from "../src/plugins/ui-schema";

for (const item of cases) {
  test(`settings number parity: ${item.name}`, () => {
    expect(settingsSchemaSchema.safeParse(item.schema).success).toBe(item.accepted);
  });
}
