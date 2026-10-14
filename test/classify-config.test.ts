import { expect, test } from "bun:test";
import { ClassifierConfigError, classifierConfig, validateClassifier } from "../src/config/classifier";
import { validateStrategy } from "../src/config/strategy";

const strategy = validateStrategy({
  planner: "codex",
  providers: { codex: {}, local: { via: "opencode", model: "lmstudio/q", usage: "unmetered" } },
}, "/test.yaml");
const providers = strategy.providers;

const decision = { use: "rules", minConfidence: 0.6, verifyKind: false, maxForCheap: 0 } as const;

test("empty input gives configured:false with all defaults", () => {
  expect(validateClassifier({}, providers)).toEqual({
    configured: false, default: "rules",
    decisions: { task_kind: decision, difficulty: decision, guard: decision, result_check: decision },
    shadow: [], shadowExternal: false, timeoutMs: 3000, logState: "trimmed",
    tiers: { codex: "capable", "opencode#local": "cheap" },
    adapters: {
      ollama: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen3.6-35b-a3b", maxTokens: 512, keyEnv: null },
      jev: { baseUrl: "https://api.typesafe.ai", model: "jev-latest", keyEnv: "TYPESAFE_API_KEY", usdPerMtokIn: null, usdPerMtokOut: null },
    },
    bench: { redact: true, timeoutMs: 30000 },
  });
  expect(classifierConfig(strategy)).toEqual(validateClassifier({}, providers));
});

test("the spec §3.9 example yields the expected normalized config", () => {
  const raw = {
    default: "rules",
    decisions: {
      task_kind: { use: "rules", verify_kind: false },
      difficulty: { use: "rules", max_for_cheap: 0.6 },
      guard: { use: "rules" }, result_check: { use: "rules" },
    },
    shadow: ["ollama"], timeout_ms: 3000,
  };
  expect(classifierConfig({ ...strategy, classifier: raw })).toMatchObject({
    configured: true, default: "rules", shadow: ["ollama"], timeoutMs: 3000,
    decisions: { task_kind: decision, difficulty: { ...decision, maxForCheap: 0.6 }, guard: decision, result_check: decision },
  });
});

test("an input with five different mistakes reports all five problems at once", () => {
  try {
    validateClassifier({ surprise: true, default: "unknown", timeout_ms: 0,
      decisions: { guard: { min_confidence: 1.1 } }, tiers: { missing: "cheap" } }, providers);
    throw new Error("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ClassifierConfigError);
    const problems = (error as ClassifierConfigError).problems;
    expect(problems).toHaveLength(5);
    for (const path of ["surprise", "default", "timeout_ms", "decisions.guard.min_confidence", "tiers.missing"]) {
      expect(problems.some((problem) => problem.includes(path))).toBe(true);
    }
  }
});

test("default tiers: opencode-routed providers cheap, native capable", () => {
  expect(validateClassifier({}, providers).tiers).toEqual({ codex: "capable", "opencode#local": "cheap" });
  expect(validateClassifier({ tiers: { "opencode#local": "capable", codex: "cheap" } }, providers).tiers)
    .toEqual({ codex: "cheap", "opencode#local": "capable" });
  expect(() => validateClassifier({ tiers: { codex: "fast" } }, providers)).toThrow(ClassifierConfigError);
});

test("the max_for_cheap default rule", () => {
  expect(validateClassifier({ default: "ollama" }, providers).decisions.difficulty)
    .toEqual({ ...decision, use: "ollama" });
  expect(validateClassifier({ decisions: { difficulty: {} } }, providers).decisions.difficulty.maxForCheap).toBe(0.6);
  expect(validateClassifier({ decisions: { difficulty: { max_for_cheap: 0 } } }, providers).decisions.difficulty.maxForCheap).toBe(0);
});

test("an http(s)-only base_url", () => {
  for (const id of ["ollama", "jev"]) {
    for (const base_url of ["file:///tmp/model", "ftp://example.com", "example.com", "http://"]) {
      expect(() => validateClassifier({ adapters: { [id]: { base_url } } }, providers)).toThrow(ClassifierConfigError);
    }
    for (const base_url of ["http://localhost:4000/v1", "https://example.com/typesafe"]) {
      expect(validateClassifier({ adapters: { [id]: { base_url } } }, providers).adapters[id as "ollama" | "jev"].baseUrl).toBe(base_url);
    }
  }
});

test("normalizes all supported overrides and decision inheritance", () => {
  expect(validateClassifier({ default: "jev", decisions: { task_kind: { verify_kind: true, min_confidence: 0 }, guard: { use: "ollama" } },
    shadow: ["rules", "jev"], shadow_external: true, timeout_ms: 500, log_state: "none",
    adapters: { ollama: { model: "q", max_tokens: 100, key_env: "LOCAL_KEY" },
      jev: { model: "custom", key_env: "JEV_KEY", usd_per_mtok_in: 0, usd_per_mtok_out: 2 } },
    bench: { redact: false, timeout_ms: 1000 },
  }, providers)).toMatchObject({
    default: "jev", decisions: { task_kind: { use: "jev", verifyKind: true, minConfidence: 0 }, guard: { use: "ollama" } },
    shadow: ["rules", "jev"], shadowExternal: true, timeoutMs: 500, logState: "none",
    adapters: { ollama: { model: "q", maxTokens: 100, keyEnv: "LOCAL_KEY" },
      jev: { model: "custom", keyEnv: "JEV_KEY", usdPerMtokIn: 0, usdPerMtokOut: 2 } },
    bench: { redact: false, timeoutMs: 1000 },
  });
});

test("rejects malformed shapes, unknown keys and invalid scalar values", () => {
  for (const raw of [null, [], "rules", { decisions: [] }, { decisions: { unknown: {} } },
    { decisions: { guard: { typo: true } } }, { decisions: { guard: { use: "bad" } } },
    { decisions: { guard: { max_for_cheap: -0.1 } } }, { decisions: { guard: { min_confidence: NaN } } },
    { shadow: "ollama" }, { shadow: ["bad"] }, { timeout_ms: Infinity }, { timeout_ms: "3000" },
    { shadow_external: "true" }, { log_state: "bad" }, { adapters: { bad: {} } },
    { adapters: { ollama: { max_tokens: 0 } } }, { adapters: { jev: { usd_per_mtok_in: -1 } } },
    { bench: { timeout_ms: 0 } }, { bench: { redact: "true" } },
  ]) expect(() => validateClassifier(raw, providers)).toThrow(ClassifierConfigError);
});
