// test/plugin-protocol-doc.test.ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginProtocolSchema, renderPluginProtocolDoc } from "../scripts/plugin-protocol-doc";
import { CAPABILITIES, CAPABILITY_METHODS, EXTENSION_METHODS, PLUGIN_PROTOCOL_VERSION } from "../src/plugins/protocol";

test("docs/plugin-protocol.md and the JSON Schema are generated and fresh: run `bun run plugin:protocol`", () => {
  const doc = renderPluginProtocolDoc();
  for (const text of [`# Plugin protocol v${PLUGIN_PROTOCOL_VERSION}`, "### `plugin.hello`", "### `diagnostic.ping`", "### `capability.log`", "### `capability.config.get`", "`plugin_timeout`", "`needs_grant`", "## Manifest", "`$/cancel`"]) expect(doc).toContain(text);
  expect(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.md"), "utf8")).toBe(doc);
  const schema = pluginProtocolSchema() as { $defs: Record<string, unknown>; title: string };
  expect(schema.title).toBe(`pacer plugin protocol ${PLUGIN_PROTOCOL_VERSION}`);
  for (const key of ["callMetadata", "manifest", "helloParams", "helloResult", "diagnostic.ping.params", "diagnostic.ping.result", "capability.log.params"]) expect(schema.$defs[key]).toBeDefined();
  expect(readFileSync(join(import.meta.dir, "..", "docs", "plugin-protocol.schema.json"), "utf8")).toBe(`${JSON.stringify(schema, null, 2)}\n`);
});

test("generated prose names current executor methods and route status, and keeps the UI contribution section", () => {
  const doc = renderPluginProtocolDoc();
  for (const text of ["## UI contributions", "`contributes.ui` has a fixed schema", "Protocol 1.9.0 adds",
    "owns production direct attempts", "with no built-in fallback",
    "Conversations, take over, remote full/PTY and interactive sessions"]) expect(doc).toContain(text);
  for (const stale of ["reports unavailable for production dispatch", "has not switched", "no production caller",
    "Other production SSH paths still require caller cutover", "staged local attempt"]) expect(doc).not.toContain(stale);
  const prose = doc.slice(doc.indexOf("Protocol 1.9.0 adds"), doc.indexOf("Peers explicitly negotiate"));
  for (const name of ["executor.run", "executor.stop", "executor.sessionState"]) {
    expect(EXTENSION_METHODS[name]).toBeDefined();
    expect(prose).toContain(`\`${name}\``);
  }
  const owned = ["claimRun", "startRun", "pollRun", "readRunOutput", "completeReportedRun", "stopRun", "inspectRun", "outputChunk"]
    .map(name => `capability.process.${name}`).concat(["prepareOwned", "claimOwned", "startOwned", "pollOwned",
      "readOwnedOutput", "stopOwned", "transferOwned"].map(name => `capability.hosts.${name}`));
  for (const name of owned) {
    expect(CAPABILITY_METHODS[name]).toBeDefined();
    expect(prose).toContain(`\`${name.split(".").at(-1)}\``);
  }
  expect(CAPABILITIES).toContain("worktree");
  expect(prose).toContain("`worktree`");
});
