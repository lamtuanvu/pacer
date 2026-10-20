import { expect, test } from "bun:test";
import { addParams, groupCandidates, modelFacts, parseCapUsd, searchCandidates, usagePill } from "../app/src/model/opencode-setup";

test("groups keep the signed-in, local, catalog order and drop empty groups", () => {
  const g = groupCandidates([{ group: "catalog", id: 1 }, { group: "signed_in", id: 2 }] as never);
  expect(g.map(([k]) => k)).toEqual(["signed_in", "catalog"]);
});

test("model facts and cap parsing", () => {
  expect(modelFacts({ context: 262144, costIn: 0.22, costOut: 0.95 })).toBe("262K context · $0.22/$0.95 per M");
  expect(modelFacts({ context: 128000, costIn: null, costOut: null })).toBe("128K context");
  expect(parseCapUsd("")).toBeUndefined();
  expect(parseCapUsd("$12.5")).toBe(12.5);
  expect(parseCapUsd("0")).toBe("Enter a positive dollar amount, or leave it blank.");
  expect(parseCapUsd("ten")).toBe("Enter a positive dollar amount, or leave it blank.");
});

test("search matches id or name, case-insensitively, up to the limit", () => {
  const list = [{ provider: "deepseek", name: "DeepSeek" }, { provider: "zhipuai", name: "Zhipu AI" }, { provider: "volcengine-coding-plan", name: "Volcengine Coding Plan" }];
  expect(searchCandidates(list, "ZHI").map(c => c.provider)).toEqual(["zhipuai"]);
  expect(searchCandidates(list, "", 2)).toHaveLength(2);
});

test("usage pills use the shared words", () => {
  expect(usagePill({ usage: "quota" })).toEqual({ label: "Quota", tone: "neutral" });
  expect(usagePill({ usage: "metered" })).toEqual({ label: "Metered", tone: "neutral" });
  expect(usagePill({ usage: "unmetered" })).toEqual({ label: "Free", tone: "good" });
});

const model = { id: "qwen/qwen3-coder", context: 262144, output: 65536, tools: true, costIn: 0.22, costOut: 0.95 };
test("a signed-in provider adds a source: opencode account with an optional cap; the test runs as the step 4 check", () => {
  expect(addParams({ candidate: { group: "signed_in", provider: "openrouter" }, model, usage: "metered", cap: "10", name: "openrouter" }))
    .toEqual({ params: { kind: "endpoint", source: "opencode", provider: "openrouter", model: "qwen/qwen3-coder", name: "openrouter", cap_usd: 10, test: false } });
  expect(addParams({ candidate: { group: "signed_in", provider: "openrouter" }, model, usage: "metered", cap: "", name: "openrouter" }))
    .toEqual({ params: { kind: "endpoint", source: "opencode", provider: "openrouter", model: "qwen/qwen3-coder", name: "openrouter", test: false } });
  expect(addParams({ candidate: { group: "signed_in", provider: "openrouter" }, model, usage: "metered", cap: "ten", name: "openrouter" }))
    .toEqual({ error: "Enter a positive dollar amount, or leave it blank." });
  expect(addParams({ candidate: { group: "signed_in", provider: "openrouter" }, model, usage: "quota", cap: "ten", name: "openrouter" }))
    .toEqual({ params: { kind: "endpoint", source: "opencode", provider: "openrouter", model: "qwen/qwen3-coder", name: "openrouter", usage: "quota", test: false } });
});

test("a local server adds a pacer-managed endpoint with no key, and names are checked", () => {
  expect(addParams({ candidate: { group: "local", provider: "ollama", base_url: "http://127.0.0.1:11434/v1" }, model, usage: "unmetered", cap: "", name: "ollama" }))
    .toEqual({ params: { kind: "endpoint", name: "ollama", base_url: "http://127.0.0.1:11434/v1", key_source: "none", models: [{ id: "qwen/qwen3-coder", context: 262144, output: 65536, tools: true }], usage: "unmetered", test: false } });
  expect(addParams({ candidate: { group: "signed_in", provider: "openrouter" }, model, usage: "metered", cap: "", name: "Open Router" }))
    .toEqual({ error: "Use lowercase letters, digits and hyphens, starting with a letter or digit." });
});
