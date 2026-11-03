import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helloBody } from "../src/api/protocol";
import { v2Hello } from "../src/api/v2-compat";

// The static Rust vector carries only the deterministic, platform-agnostic
// inventory. coreBuild is a runtime property of the actual paired core and is
// obtained from the running core at hello time (stdio_proxy.rs), never from
// the static file. Strip it from the live body so the two stay comparable.
const { coreBuild: _coreBuild, ...inventory } = helloBody() as Record<string, unknown>;

test("Rust stdio hello inventory matches both TypeScript protocol versions", () => {
  const generated = JSON.parse(readFileSync(join(import.meta.dir, "../crates/server/src/stdio_hello.json"), "utf8"));
  expect(generated).toEqual({ v2: v2Hello(), v3: inventory });
  // The static vector must never encode a platform-specific build descriptor.
  expect("coreBuild" in (generated.v3 as object)).toBe(false);
});