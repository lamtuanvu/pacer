/**
 * Parity scenarios for `pacer-classify` (M3 C6). The driver acts as the host
 * over stdio and answers every `capability.*` call this plugin makes from the
 * per-scenario `answers`, so the TypeScript and Rust processes run the same
 * scripted host traffic and their transcripts must match exactly.
 *
 * `classifier.adapters` reads the host configuration via `capability.config.get`;
 * the external `rules` adapter is pure; the `ollama` and `jev` adapters check a
 * secret via `capability.secrets.check` and POST via `capability.net.http`. The
 * Rust side only runs when PACER_TEST_FRONT_DOOR points at a `pacer` built from
 * this branch; without it the test is skipped.
 */
import { describe, expect, test } from "bun:test";
import { parity, rustArgv } from "./driver";
import type { Answer, Step, Transcript } from "./driver";

/** A valid `adapterConfig` snapshot (config.ts:5-6). */
function adapterConfig(ollamaBaseUrl: string): Record<string, unknown> {
  return {
    adapters: {
      rules: {},
      ollama: {
        baseUrl: ollamaBaseUrl,
        model: "qwen3.6-35b-a3b",
        maxTokens: 256,
        keyRef: null,
      },
      jev: {
        baseUrl: "https://api.typesafe.ai",
        model: "systemone",
        keyRef: "env:JEV_API_KEY",
        usdPerMtokIn: null,
        usdPerMtokOut: null,
      },
    },
  };
}

const configAnswer = (ollamaBaseUrl: string): Answer =>
  () => ({ config: adapterConfig(ollamaBaseUrl) });

/** An owning `classifier.ask` step with the given params. */
function askStep(adapter: string, question: Record<string, unknown>, config: unknown, state = "{}"): Step {
  return {
    method: "classifier.ask",
    params: { adapter, state, question, timeoutMs: 5000, config },
  };
}

const choiceQ = {
  type: "choice",
  id: "task_kind",
  instructions: "Choose the task kind",
  criteria: { tests: "Testing work", docs: "Documentation work" },
};
const yesnoQ = { type: "yesno", id: "guard", instructions: "Is this execution work?" };

const ollamaBody = JSON.stringify({
  choices: [{ message: { content: '{"choice":"tests","confidence":0.9}' } }],
});
const ollamaPost: Answer = () => ({ status: 200, headers: {}, body: ollamaBody });
const secretsPresent = (present: boolean): Answer => () => ({ present });

/** The `capability.net.http` params the plugin posted, in call order. */
function httpPosts(t: Transcript): any[] {
  return t.calls
    .filter((c) => c.method === "capability.net.http")
    .map((c) => c.params);
}

// The external adapters measure wall-clock latency, which differs between the
// TypeScript and Rust processes; collapse it (each adapter also returns it at 0
// in its own unit tests).
const normalize = (t: Transcript): Transcript => {
  const s = structuredClone(t);
  for (const step of s.steps) {
    if (step.result && typeof step.result === "object" && step.result !== null) {
      const result = step.result as Record<string, unknown>;
      if ("latencyMs" in result) result.latencyMs = 0;
    }
  }
  return s;
};

describe("pacer-classify parity (TypeScript vs Rust)", () => {
  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.adapters reports a local ollama as non-external",
    async () => {
      const { ts, rust } = await parity(
        "pacer-classify",
        [{ method: "classifier.adapters", params: {} }],
        { "capability.config.get": configAnswer("http://127.0.0.1:1234/v1") },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.adapters reports a remote ollama as external",
    async () => {
      const { ts, rust } = await parity(
        "pacer-classify",
        [{ method: "classifier.adapters", params: {} }],
        { "capability.config.get": configAnswer("https://api.example.com/v1") },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask rules task_kind is pure",
    async () => {
      const { ts, rust } = await parity(
        "pacer-classify",
        [askStep("rules", choiceQ, {}, '{"planner_kind":"tests"}')],
        {},
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask rules guard returns probabilities",
    async () => {
      const { ts, rust } = await parity(
        "pacer-classify",
        [askStep("rules", yesnoQ, {}, '{"subagent_type":"reviewer"}')],
        {},
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask ollama posts anonymously when the key is absent",
    async () => {
      const ollamaCfg = {
        baseUrl: "https://api.example.com/v1", model: "m", maxTokens: 256, keyRef: null,
      };
      const { ts, rust } = await parity(
        "pacer-classify",
        [
          askStep("ollama", choiceQ, ollamaCfg, '{"goal":"write tests for login"}'),
        ],
        { "capability.net.http": ollamaPost },
        {},
        normalize,
      );
      expect(rust).toEqual(ts);
      // Anonymous: no secrets check was made and no authorization header sent.
      expect(ts.calls.some((c) => c.method === "capability.secrets.check")).toBe(false);
      const post = httpPosts(ts)[0];
      expect(post.url).toBe("https://api.example.com/v1/chat/completions");
      expect(post.authorization).toBeUndefined();
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask ollama sends authorization when the key is present",
    async () => {
      const ollamaCfg = {
        baseUrl: "https://api.example.com/v1", model: "m", maxTokens: 256, keyRef: "env:OLLAMA_KEY",
      };
      const { ts, rust } = await parity(
        "pacer-classify",
        [askStep("ollama", choiceQ, ollamaCfg, '{"goal":"write tests for login"}')],
        {
          "capability.secrets.check": secretsPresent(true),
          "capability.net.http": ollamaPost,
        },
        {},
        normalize,
      );
      expect(rust).toEqual(ts);
      // The resolved secret reference is forwarded as an authorization header.
      expect(ts.calls.filter((c) => c.method === "capability.secrets.check")).toHaveLength(1);
      expect(httpPosts(ts)[0].authorization).toEqual({ secretRef: "env:OLLAMA_KEY" });
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask jev maps the answer and computes a usage cost",
    async () => {
      const jevCfg = {
        baseUrl: "https://api.typesafe.ai", model: "systemone", keyRef: "env:JEV_API_KEY",
        usdPerMtokIn: 2, usdPerMtokOut: 5,
      };
      const jevPost: Answer = () => ({
        status: 200,
        headers: {},
        body: JSON.stringify({
          answers: { guard: { type: "probability", probability: 0.8 } },
          usage: { input_tokens: 1000, output_tokens: 500 },
        }),
      });
      const { ts, rust } = await parity(
        "pacer-classify",
        [askStep("jev", yesnoQ, jevCfg, '{"goal":"decide"}')],
        {
          "capability.secrets.check": secretsPresent(true),
          "capability.net.http": jevPost,
        },
        {},
        normalize,
      );
      expect(rust).toEqual(ts);
      // The usage prices are applied: (1000*2 + 500*5) / 1e6 = 0.0045.
      const result = ts.steps[0].result as { costUsd?: number; value?: unknown; confidence?: number };
      expect(result.costUsd).toBe(0.0045);
      expect(result.value).toBe(true);
    },
    30000,
  );

  test.skipIf(!rustArgv("pacer-classify"))(
    "classifier.ask jev fails fast when the key is missing",
    async () => {
      const jevCfg = {
        baseUrl: "https://api.typesafe.ai", model: "systemone", keyRef: "env:JEV_API_KEY",
        usdPerMtokIn: null, usdPerMtokOut: null,
      };
      const { ts, rust } = await parity(
        "pacer-classify",
        [askStep("jev", yesnoQ, jevCfg, "{}")],
        { "capability.secrets.check": secretsPresent(false) },
      );
      expect(rust).toEqual(ts);
    },
    30000,
  );
});