import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opJsonSchemas } from "../src/api/ops";

test("Rust op_catalog.json matches TypeScript opJsonSchemas()", () => {
  const generated = JSON.parse(
    readFileSync(join(import.meta.dir, "../crates/server/src/op_catalog.json"), "utf8"),
  );
  expect(generated).toEqual(opJsonSchemas());
});
