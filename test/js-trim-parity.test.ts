import { expect, test } from "bun:test";
import rows from "./fixtures/js-trim-parity.json";

test("ECMAScript trim parity fixture", () => {
  for (const row of rows) expect(row.value.trim()).toBe(row.expected);
});
