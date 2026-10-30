import { shutdownPlugins } from "../src/plugins";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateClassifier } from "../src/config/classifier";
import { decide, TimeoutError, withTimeout } from "../src/classify/decide";
import { appendDecision, decisionsFile, loggedState, newDecisionId, readDecisions } from "../src/classify/log";
import { buildAdapters, type AdapterSet } from "../src/classify/registry";
import { rulesClassifier as pluginRules } from "../plugins/pacer-classify/rules";
const rulesClassifier = { ...pluginRules, ask: (state: string, question: import("../src/classify/types").Question) => pluginRules.ask(state, question, 3000) };
import { QUESTIONS } from "../src/classify/state";
import type { Answer, Classifier, DecisionEntry } from "../src/classify/types";
import { fakeCtx } from "./helpers";

const answer: Answer = { value: "feature", confidence: 0.9, latencyMs: 12, costUsd: 0.001 };
const state = '{"goal":"implement API"}';
const input = { decision: "task_kind" as const, state, question: QUESTIONS.task_kind, actedOn: true, taskId: "task-6" };
const cfg = (raw: unknown = {}) => validateClassifier(raw, {});
function adapters(ask: Classifier["ask"] = async () => answer): AdapterSet {
  return { rules: rulesClassifier, ollama: { id: "ollama", external: false, ask }, jev: { id: "jev", external: true, ask: async () => answer } };
}

describe("classifier decide", () => {
  test("an acting entry is logged with all fields", async () => {
    const ctx = fakeCtx();
    expect(await decide(ctx, cfg({ default: "ollama" }), adapters(), input)).toEqual({ answer, adapter: "ollama", fallback: false });
    const entries = readDecisions(ctx);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ts: ctx.now, decision: "task_kind", state_hash: "51dbdf58c0134064", state, question: QUESTIONS.task_kind, adapter: "ollama", answer, acted_on: true, fallback: false, task_id: "task-6" });
    expect(entries[0].id).toMatch(/^d-[0-9a-f]{12}$/);
    expect(JSON.parse(readFileSync(decisionsFile(ctx), "utf8"))).toEqual(entries[0]);
  });

  for (const scenario of ["low confidence", "timeout", "error"] as const) {
    test(`falls back to rules on ${scenario} and logs the cause`, async () => {
      const ctx = fakeCtx();
      const attempted = { ...answer, confidence: 0.2 };
      const set = adapters(async () => {
        if (scenario === "low confidence") return attempted;
        if (scenario === "error") throw new Error("offline");
        return new Promise<Answer>(() => {});
      });
      const result = await decide(ctx, cfg({ default: "ollama", timeout_ms: 10 }), set, input);
      expect(result).toMatchObject({ adapter: "rules", fallback: true, answer: { value: "feature", confidence: 0.6 } });
      const entries = readDecisions(ctx);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ adapter: "rules", fallback: true, fallback_from: "ollama", acted_on: true });
      expect(entries[0].fallback_reason).toMatch(scenario === "low confidence" ? /confidence/i : scenario === "timeout" ? /timeout|timed out/i : /offline/);
      if (scenario === "low confidence") expect(entries[0].attempted).toEqual(attempted);
    });
  }

  test("rules itself never falls back even below the minimum confidence", async () => {
    const ctx = fakeCtx();
    const result = await decide(ctx, cfg(), adapters(), { ...input, state: '{}', actedOn: false });
    expect(result).toMatchObject({ adapter: "rules", fallback: false, answer: { value: "default", confidence: 0.5 } });
    expect(readDecisions(ctx)[0]).toMatchObject({ fallback: false, acted_on: false });
  });

  test("explicit use selects rules and excludes the acting adapter from shadows", async () => {
    const ctx = fakeCtx();
    await decide(ctx, cfg({ default: "ollama", shadow: ["rules", "ollama", "ollama"] }), adapters(), { ...input, use: "rules" });
    expect(readDecisions(ctx).map(e => [e.adapter, e.acted_on]).sort()).toEqual([["ollama", false], ["rules", true]]);
  });

  test("shadows run concurrently and are logged with acted_on false", async () => {
    const ctx = fakeCtx();
    let release!: (a: Answer) => void;
    const acting = new Promise<Answer>(resolve => { release = resolve; });
    const set = adapters(() => acting);
    set.jev.ask = async () => { release(answer); return { ...answer, value: "docs" }; };
    await decide(ctx, cfg({ default: "ollama", shadow: ["jev"], shadow_external: true, timeout_ms: 100 }), set, input);
    expect(readDecisions(ctx).find(e => e.adapter === "jev")).toMatchObject({ answer: { value: "docs" }, acted_on: false, fallback: false, shadow: true });
    expect(readDecisions(ctx).find(e => e.acted_on)).toMatchObject({ adapter: "ollama", fallback: false });
  });

  for (const external of [false, true]) {
    test(`external shadow is ${external ? "included" : "skipped"} with shadow_external ${external}`, async () => {
      const ctx = fakeCtx();
      await decide(ctx, cfg({ shadow: ["jev"], shadow_external: external }), adapters(), input);
      expect(readDecisions(ctx).map(e => e.adapter).sort()).toEqual(external ? ["jev", "rules"] : ["rules"]);
    });
  }

  test("shadow errors are logged with answer null without fallback", async () => {
    const ctx = fakeCtx();
    await decide(ctx, cfg({ shadow: ["ollama"] }), adapters(async () => { throw new Error("shadow offline"); }), input);
    expect(readDecisions(ctx).find(e => !e.acted_on)).toMatchObject({ adapter: "ollama", answer: null, error: "shadow offline", fallback: false, shadow: true });
  });

  test("shadow timeouts are bounded and logged", async () => {
    const ctx = fakeCtx();
    await decide(ctx, cfg({ shadow: ["ollama"], timeout_ms: 10 }), adapters(() => new Promise(() => {})), input);
    expect(readDecisions(ctx).find(e => !e.acted_on)).toMatchObject({ answer: null });
    expect(readDecisions(ctx).find(e => !e.acted_on)?.error).toMatch(/timeout|timed out/i);
  });

  test("log_state none logs null and trimmed redacts long strings and home", async () => {
    const ctx = fakeCtx();
    await decide(ctx, cfg({ log_state: "none" }), adapters(), input);
    expect(readDecisions(ctx)[0].state).toBeNull();
    const longState = JSON.stringify({ goal: ctx.home + "/" + "x".repeat(250) });
    await decide(ctx, cfg({ log_state: "trimmed" }), adapters(), { ...input, state: longState });
    expect(JSON.parse(readDecisions(ctx)[1].state!)).toEqual({ goal: "~/" + "x".repeat(198) + "..." });
    expect(loggedState(state, "full", ctx.home)).toBe(state);
  });

  test("decide still returns when decisions.jsonl is a directory", async () => {
    const ctx = fakeCtx();
    mkdirSync(decisionsFile(ctx), { recursive: true });
    expect(await decide(ctx, cfg(), adapters(), input)).toMatchObject({ adapter: "rules", fallback: false });
  });

  test("readDecisions skips corrupt lines and filters timestamps inclusively", async () => {
    const ctx = fakeCtx();
    expect(readDecisions(ctx)).toEqual([]);
    await decide(ctx, cfg(), adapters(), input);
    const entry = readDecisions(ctx)[0];
    writeFileSync(decisionsFile(ctx), `broken\n${JSON.stringify(entry)}\n\n{\n${JSON.stringify({ ...entry, ts: ctx.now - 1 })}\n`);
    expect(readDecisions(ctx, ctx.now)).toEqual([entry]);
    const later: DecisionEntry = { ...entry, id: newDecisionId(), ts: ctx.now + 1 };
    appendDecision(ctx, later);
    expect(readDecisions(ctx, ctx.now)).toEqual([entry, later]);
  });

  test("buildAdapters returns three ids with correct external flags", () => {
    const ctx = fakeCtx();
    const local = buildAdapters(ctx, cfg(), 10);
    expect(Object.keys(local).sort()).toEqual(["jev", "ollama", "rules"]);
    expect(Object.values(local).map(a => [a.id, a.external])).toEqual([["rules", false], ["ollama", false], ["jev", true]]);
    const remote = buildAdapters(ctx, cfg({ adapters: { ollama: { base_url: "https://models.example/v1" } } }), 10);
    expect(remote.ollama.external).toBe(true);
  });

  test("Jev secrets are read lazily and permission errors fall back", async () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "secrets"), "TYPESAFE_API_KEY=test-key");
    chmodSync(join(ctx.pacerHome, "secrets"), 0o644);
    const config = cfg({ default: "jev" });
    const set = buildAdapters(ctx, config, 3000);
    try {
      expect(await decide(ctx, config, set, input)).toMatchObject({ adapter: "rules", fallback: true });
      expect(readDecisions(ctx)[0].fallback_reason).toContain("bound credential could not be resolved");
      expect(JSON.stringify(readDecisions(ctx))).not.toContain("test-key");
    } finally { await shutdownPlugins(ctx); }
  });

  test("local adapter secret is resolved by the host at call time", async () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "secrets"), "LOCAL_KEY=private-token");
    chmodSync(join(ctx.pacerHome, "secrets"), 0o644);
    const set = buildAdapters(ctx, cfg({ adapters: { ollama: { key_env: "LOCAL_KEY" } } }), 3000);
    try {
      await expect(set.ollama.ask(input.state, input.question)).rejects.toMatchObject({ code: "capability_denied" });
    } finally { await shutdownPlugins(ctx); }
  });

  test("logged errors scrub bearer tokens, sk keys, long hex/base64 and cap text", async () => {
    const ctx = fakeCtx();
    const messages = ["Authorization: Bearer private-token", "key sk-private-token", "hex " + "a".repeat(64), "base64 " + "QWJj".repeat(16), "word ".repeat(80)];
    for (const message of messages) {
      await decide(ctx, cfg({ default: "ollama", shadow: ["jev"], shadow_external: true }), {
        ...adapters(async () => { throw new Error(message); }),
        jev: { id: "jev", external: true, ask: async () => { throw new Error(message); } },
      }, input);
    }
    const entries = readDecisions(ctx);
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      const text = entry.error ?? entry.fallback_reason!;
      expect(text.length).toBeLessThanOrEqual(200);
      expect(text).not.toContain("private-token");
      expect(text).not.toContain("a".repeat(64));
      expect(text).not.toContain("QWJj".repeat(16));
    }
  });

  test("withTimeout returns resolved values, preserves errors, and rejects hanging calls", async () => {
    expect(await withTimeout(Promise.resolve(7), 10, "test")).toBe(7);
    await expect(withTimeout(Promise.reject(new Error("original")), 10, "test")).rejects.toThrow("original");
    await expect(withTimeout(new Promise(() => {}), 10, "test")).rejects.toBeInstanceOf(TimeoutError);
  });
});


test("decision log is private and rotates oversized files replacing the old backup", async () => {
  const ctx = fakeCtx();
  await decide(ctx, cfg(), adapters(), input);
  const path = decisionsFile(ctx);
  const oversized = "x".repeat(10 * 1024 * 1024 + 1);
  writeFileSync(path, oversized);
  writeFileSync(path + ".1", "old backup");
  await decide(ctx, cfg(), adapters(), input);
  expect(readFileSync(path + ".1", "utf8")).toBe(oversized);
  expect(readDecisions(ctx)).toHaveLength(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("unconfigured decisions log trimmed brief, report and acceptance output", async () => {
  const ctx = fakeCtx();
  const long = ctx.home + "/" + "private ".repeat(100);
  await decide(ctx, cfg(), adapters(), { ...input, state: JSON.stringify({ goal: long, report: long, acceptance: { tail: long } }) });
  const state = JSON.parse(readDecisions(ctx)[0].state!);
  for (const text of [state.goal, state.report, state.acceptance.tail]) {
    expect(text.length).toBeLessThanOrEqual(203);
    expect(text).not.toContain(ctx.home);
  }
});

test("guard returns before an unresolved shadow adapter", async () => {
  const ctx = fakeCtx();
  let release!: (answer: Answer) => void;
  const shadow = new Promise<Answer>(resolve => { release = resolve; });
  const pending = decide(ctx, cfg({ shadow: ["ollama"], timeout_ms: 1000 }), adapters(() => shadow), {
    decision: "guard", state: '{"subagent_type":"Explore"}', question: QUESTIONS.guard, actedOn: true,
  });
  try {
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("blocked"), 50))]);
    expect(result).not.toBe("blocked");
  } finally { release(answer); await pending; }
});

test("new decision logs have mode 0600", async () => {
  const ctx = fakeCtx();
  await decide(ctx, cfg(), adapters(), input);
  expect(statSync(decisionsFile(ctx)).mode & 0o777).toBe(0o600);
});
