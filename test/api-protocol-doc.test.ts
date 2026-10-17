import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderProtocolDoc } from "../scripts/protocol-doc";
import { opNames } from "../src/api/ops";

test("docs/protocol.md is generated from the registry and up to date: run `bun run protocol:doc`", () => {
  const doc = renderProtocolDoc();
  for (const name of opNames()) expect(doc).toContain(`### \`${name}\``);
  expect(doc).toContain("2.1.0");
  expect(readFileSync(join(import.meta.dir, "..", "docs", "protocol.md"), "utf8")).toBe(doc);
});
