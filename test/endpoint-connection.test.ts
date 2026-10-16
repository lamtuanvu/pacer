import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import type { EndpointConnection } from "../src/config/accounts";

const connection: EndpointConnection = {api: "openai-compatible", base_url: "https://example.test/v1", key: "env:TEST_KEY", models: [{id: "org/model", name: "Model", context: 128000, output: 16000, tools: true}]};
function parse(c: unknown = connection, kind = "endpoint", model?: string) {
  return validateStrategy({planner: "claude-code", accounts: {main: {kind: "claude"}, "test-api": {kind, usage: "unmetered", connection: c}}, runners: {"opencode#test-api": model ? {model} : {}}}, "strategy.yaml");
}
test("connection is exposed and derives the managed provider model", () => {
  const s = parse();
  expect(s.accounts["test-api"].connection).toEqual(connection);
  expect(s.runners["opencode#test-api"].model).toBe("pacer-test-api/org/model");
  expect(parse(connection, "endpoint", "org/model").providers["opencode#test-api"].model).toBe("pacer-test-api/org/model");
  expect(parse(connection, "endpoint", "pacer-test-api/org/model").runners["opencode#test-api"].model).toBe("pacer-test-api/org/model");
});
test.each([
  [null, "connection must be a mapping"],
  [{...connection, api: "anthropic"}, "connection.api"],
  [{...connection, base_url: "file:///tmp/api"}, "connection.base_url"],
  [{...connection, base_url: "invalid"}, "connection.base_url"],
  [{...connection, key: "sk-never-echo-this"}, "connection.key"],
  [{...connection, key: "env:1INVALID"}, "connection.key"],
  [{...connection, models: []}, "connection.models"],
  [{...connection, models: [{id: "", context: 1, output: 1, tools: true}]}, "models.0.id"],
  [{...connection, models: [{id: "m", context: 0, output: 1, tools: true}]}, "models.0.context"],
  [{...connection, models: [{id: "m", context: 1, output: -1, tools: true}]}, "models.0.output"],
  [{...connection, models: [{id: "m", context: 1, output: 1}]}, "models.0.tools"],
  [{...connection, models: [{id: "m", name: 3, context: 1, output: 1, tools: true}]}, "models.0.name"],
] as [unknown, string][])("invalid connection %# is rejected without echoing values", (c, message) => {
  expect(() => parse(c)).toThrow(message);
  try { parse(c); } catch (e) { expect(String(e)).not.toContain("sk-never-echo-this"); }
});
test("connections belong to endpoints and runner models must be selected", () => {
  expect(() => parse(connection, "codex")).toThrow("connection requires an endpoint");
  expect(() => parse(connection, "endpoint", "other/model")).toThrow("connection.models");
});
test("legacy endpoints keep their external model", () => {
  const s = validateStrategy({planner: "opencode", providers: {local: {via: "opencode", model: "external/model", usage: "unmetered"}}}, "strategy.yaml");
  expect(s.accounts.local.connection).toBeUndefined();
  expect(s.runners["opencode#local"].model).toBe("external/model");
});
