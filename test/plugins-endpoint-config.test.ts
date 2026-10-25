import { expect, test } from "bun:test";
import { endpointKeyEnv, renderOpencodeConfig, type EndpointAccount } from "../plugins/pacer-endpoints/opencode-config";

const account: EndpointAccount = {
  name: "test-api", baseUrl: "https://example.test/v1", keyRef: "endpoint:test-api",
  models: [{ id: "model", context: 128000, output: 16000, tools: true }],
};
test("plugin config preserves managed provider metadata and fixed environment placeholders", () => {
  const rendered = renderOpencodeConfig([account]);
  expect(rendered).toEqual({
    $schema: "https://opencode.ai/config.json",
    provider: { "pacer-test-api": {
      npm: "@ai-sdk/openai-compatible", name: "test-api (pacer)",
      options: { baseURL: "https://example.test/v1", apiKey: "{env:PACER_KEY_TEST_API}" },
      models: { model: { name: "model", limit: { context: 128000, output: 16000 }, tool_call: true } },
    } },
  });
  expect(JSON.stringify(rendered)).not.toContain("endpoint:test-api");
});
test("all projected managed accounts retain their own URL, key policy and models", () => {
  const local: EndpointAccount = { name: "local", baseUrl: "http://127.0.0.1:11434/v1", keyRef: null, models: [{ id: "local/a", name: "Local A", context: 4096, output: 512, tools: false }] };
  const rendered = renderOpencodeConfig([account, local]);
  expect(Object.keys(rendered.provider)).toEqual(["pacer-test-api", "pacer-local"]);
  expect(rendered.provider["pacer-local"]).toEqual({ npm: "@ai-sdk/openai-compatible", name: "local (pacer)", options: { baseURL: local.baseUrl }, models: { "local/a": { name: "Local A", limit: { context: 4096, output: 512 }, tool_call: false } } });
  expect(rendered.provider["pacer-test-api"]!.options.apiKey).toBe("{env:PACER_KEY_TEST_API}");
});
test("model display fallback preserves empty names and last duplicate model semantics", () => {
  const rendered = renderOpencodeConfig([{ ...account, models: [
    { id: "fallback", context: 1, output: 2, tools: true },
    { id: "empty", name: "", context: 3, output: 4, tools: false },
    { id: "duplicate", name: "before", context: 5, output: 6, tools: true },
    { id: "duplicate", name: "after", context: 7, output: 8, tools: false },
  ] }]);
  expect(rendered.provider["pacer-test-api"]!.models).toEqual({
    fallback: { name: "fallback", limit: { context: 1, output: 2 }, tool_call: true },
    empty: { name: "", limit: { context: 3, output: 4 }, tool_call: false },
    duplicate: { name: "after", limit: { context: 7, output: 8 }, tool_call: false },
  });
});
test("config rendering never serializes references or extra credential fields", () => {
  const secret = "sk-owned-render-only-secret";
  const projected = { ...account, keyRef: `endpoint:${secret}`, rawKey: secret, models: [{ ...account.models[0]!, rawKey: secret }] };
  const rendered = renderOpencodeConfig([projected]);
  expect(JSON.stringify(rendered)).not.toContain(secret);
  expect(rendered.provider["pacer-test-api"]!.options).toEqual({ baseURL: account.baseUrl, apiKey: "{env:PACER_KEY_TEST_API}" });
});
test("empty accounts and model IDs including object-prototype names remain ordinary records", () => {
  expect(renderOpencodeConfig([])).toEqual({ $schema: "https://opencode.ai/config.json", provider: {} });
  const rendered = renderOpencodeConfig([{ ...account, models: [{ id: "__proto__", context: 1, output: 1, tools: false }] }]);
  expect(Object.hasOwn(rendered.provider["pacer-test-api"]!.models, "__proto__")).toBe(true);
  expect(rendered.provider["pacer-test-api"]!.models["__proto__"]).toEqual({ name: "__proto__", limit: { context: 1, output: 1 }, tool_call: false });
});
test("environment names preserve uppercase and hyphen substitution without mutating inputs", () => {
  expect(endpointKeyEnv("my-endpoint-2")).toBe("PACER_KEY_MY_ENDPOINT_2");
  const before = JSON.stringify(account);
  const rendered = renderOpencodeConfig([account]);
  rendered.provider["pacer-test-api"]!.models.model!.limit.context = 1;
  expect(JSON.stringify(account)).toBe(before);
});
