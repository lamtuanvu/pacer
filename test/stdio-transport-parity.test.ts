import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";

test("Rust stdio hello inventory matches both TypeScript protocol versions", () => {
  const generated = JSON.parse(readFileSync(join(import.meta.dir, "../crates/server/src/stdio_hello.json"), "utf8"));
  // coreBuild describes the running core, so the Rust proxy asks the core for it at runtime.
  // pacer changes with every release, so the Rust proxy uses its own build version.
  const { coreBuild: _coreBuild, pacer: _v3Pacer, ...v3 } = helloBody();
  const { pacer: _v2Pacer, ...v2 } = v2Hello();
  expect(generated).toEqual({ v2, v3 });
  expect(generated.v3.coreBuild).toBeUndefined();
  expect(generated.v2.pacer ?? generated.v3.pacer).toBeUndefined();
});
