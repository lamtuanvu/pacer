import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";

test("Rust stdio hello inventory matches both TypeScript protocol versions", () => {
  const generated = JSON.parse(readFileSync(join(import.meta.dir, "../crates/server/src/stdio_hello.json"), "utf8"));
  // coreBuild describes the running core; the Rust proxy asks the core for it at runtime.
  const { coreBuild: _coreBuild, ...v3 } = helloBody();
  expect(generated).toEqual({ v2: v2Hello(), v3 });
  expect(generated.v3.coreBuild).toBeUndefined();
});
