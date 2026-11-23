import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Capture path used during merges: tools from ts-stdio goldens, JSON.stringify UTF-8. */
function regenerateCatalog(): string {
  const golden = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures/mcp/ts-stdio-golden.json"), "utf8"),
  );
  const out = { planner: golden.planner.tools, grant: golden.grant.tools };
  return JSON.stringify(out, null, 2) + "\n";
}

test("mcp catalog.json matches golden tools and is deterministic UTF-8", () => {
  const a = regenerateCatalog();
  const b = regenerateCatalog();
  expect(a).toBe(b);
  const committed = readFileSync(join(import.meta.dir, "../crates/mcp/src/catalog.json"), "utf8");
  expect(committed).toBe(a);
  // JS JSON.stringify emits a literal en dash; Python json.dumps escapes as \\u2013.
  expect(committed.includes("\\u2013")).toBe(false);
  expect(committed.includes("1–60")).toBe(true);
});
