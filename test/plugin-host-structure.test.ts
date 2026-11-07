import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("plugin host inline test suites stay within CRATE-11", () => {
  const source = join(import.meta.dir, "../crates/plugin-host/src");
  for (const name of readdirSync(source).filter(name => name.endsWith(".rs"))) {
    const text = readFileSync(join(source, name), "utf8");
    const start = text.indexOf("#[cfg(test)]\nmod tests {");
    if (start < 0) continue;
    expect(text.slice(start).split("\n").length - 1).toBeLessThanOrEqual(150);
  }
  // The stdio plugin transport and its async tests moved to pacer-plugin-runtime.
  const runtime = join(import.meta.dir, "../crates/plugin-runtime/src");
  expect(readFileSync(join(runtime, "process/tests.rs"), "utf8")).toContain("#[tokio::test]");
});
