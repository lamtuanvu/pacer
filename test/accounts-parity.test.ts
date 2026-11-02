import {expect, test} from "bun:test";
import {OPS} from "../src/api/ops";

// These are TypeScript reference cases for a future native account implementation.
// Parsing alone avoids network, subprocesses and persistent account state.
const model = {id: "model", context: 1, output: 1, tools: true};
const endpoint = {kind: "endpoint", name: "work", base_url: "https://example.test/v1", key_source: "none", models: [model], usage: "unmetered"};
const accepted = (op: string, params: unknown) => OPS[op]!.params.safeParse(params).success;

test("account endpoint integer fields follow the TypeScript schema", () => {
  for (const field of ["context", "output"] as const) {
    for (const [value, valid] of [[1, true], [1e2, true], [1.5, false], [0, false], [-1, false], [Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER + 1, false]] as const) {
      const models = [{...model, [field]: value}];
      expect(accepted("account.add", {...endpoint, models})).toBe(valid);
      expect(accepted("account.edit", {name: "work", models})).toBe(valid);
    }
  }
  for (const [value, valid] of [[1, true], [1e2, true], [1.5, false], [0, false], [-1, false], [Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER + 1, false]] as const) {
    expect(accepted("account.add", {...endpoint, weekly_tokens: value})).toBe(valid);
    expect(accepted("account.edit", {name: "work", weekly_tokens: value})).toBe(valid);
  }
});

test("OpenCode provider cap accepts positive finite numbers", () => {
  const params = {kind: "endpoint", source: "opencode", provider: "openrouter", model: "model"};
  for (const [value, valid] of [[0.5, true], [1e2, true], [0, false], [-1, false], [Infinity, false], [NaN, false]] as const) {
    expect(accepted("account.add", {...params, cap_usd: value})).toBe(valid);
  }
});

test("account schema distinguishes managed and OpenCode provider input", () => {
  expect(accepted("account.add", endpoint)).toBe(true);
  expect(accepted("account.add", {...endpoint, models: []})).toBe(false);
  expect(accepted("account.add", {...endpoint, base_url: "file:///tmp/model"})).toBe(false);
  expect(accepted("account.add", {kind: "endpoint", source: "opencode", provider: "openrouter", model: "model"})).toBe(true);
  expect(accepted("account.add", {kind: "endpoint", source: "opencode", provider: "Bad Provider", model: "model"})).toBe(false);
  expect(accepted("account.remove", {name: "work-1", delete_home: true})).toBe(true);
  expect(accepted("account.remove", {name: "../work"})).toBe(false);
});

test("shared strategy account boundaries match the TypeScript validator", async () => {
  const {validateStrategy} = await import("../src/config/strategy");
  const cases = await Bun.file("test/fixtures/strategy-read/account-parity.json").json() as {name: string; raw: unknown; valid: boolean}[];
  for (const item of cases) {
    let valid = true;
    try { validateStrategy(item.raw, "strategy.yaml", "parity"); } catch { valid = false; }
    expect(valid).toBe(item.valid);
  }
});
