// test/plugin-protocol-doc.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginProtocolSchema, renderPluginProtocolDoc } from "../scripts/plugin-protocol-doc";

test("docs/plugin-protocol.md and the JSON Schema are generated and fresh: run `bun run plugin:protocol`", () => {
  const doc = renderPluginProtocolDoc();
  for (const text of ["# Plugin protocol v1.1.0", "### `plugin.hello`", "### `diagnostic.ping`", "### `capability.log`", "### `capability.config.get`", "`plugin_timeout`", "`needs_grant`", "## Manifest", "`$/cancel`"]) expect(doc).toContain(text);
  expect(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.md"), "utf8")).toBe(doc);
  const schema = pluginProtocolSchema() as { $defs: Record<string, unknown>; title: string };
  expect(schema.title).toBe("pacer plugin protocol 1.1.0");
  for (const key of ["callMetadata", "manifest", "helloParams", "helloResult", "diagnostic.ping.params", "diagnostic.ping.result", "capability.log.params"]) expect(schema.$defs[key]).toBeDefined();
  expect(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.schema.json"), "utf8")).toBe(`${JSON.stringify(schema, null, 2)}\n`);
});
