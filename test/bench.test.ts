import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBench, renderBench } from "../src/classify/bench";
import { appendDecision } from "../src/classify/log";
import { rulesClassifier as pluginRules } from "../plugins/pacer-classify/rules";
const rulesClassifier = { ...pluginRules, ask: (state: string, question: Parameters<typeof pluginRules.ask>[1]) => pluginRules.ask(state, question, 3000) };
import { QUESTIONS, stateHash } from "../src/classify/state";
import type { AdapterSet } from "../src/classify/registry";
import type { Classifier, DecisionEntry, DecisionName } from "../src/classify/types";
import { validateClassifier } from "../src/config/classifier";
import { findCommand } from "../src/commands";
import { appendLabel } from "../src/tasks/labels";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

const cfg = () => validateClassifier({}, {});
function log(ctx: Ctx, decision: DecisionName, state: object, overrides: Partial<DecisionEntry> = {}) {
  const s = JSON.stringify(state);
  const e: DecisionEntry = { ts: ctx.now, id: `d-${stateHash(s)}`, decision, state: s, state_hash: stateHash(s),
    question: QUESTIONS[decision], adapter: "rules", answer: null, acted_on: true, fallback: false, ...overrides };
  appendDecision(ctx, e);
  return e;
}
function set(adapter: Classifier = rulesClassifier): AdapterSet {
  return { rules: rulesClassifier, ollama: adapter, jev: adapter };
}
const options = { adapters: ["ollama"] as const, sinceS: 0, limit: 500 };

test("fixture labels give exact accuracy, AUC, calibration, latency, cost, agreement and counterfactuals", async () => {
  const ctx = fakeCtx();
  const config = cfg();
  config.tiers = { cheap: "cheap", capable: "capable" };
  const scores = [0.2, 0.8, 0.4, 0.9];
  for (let i = 0; i < 4; i++) {
    const t = createTask(ctx, { brief: { goal: `Task ${i}`, repo: "/tmp/repo" }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, t => { t.result = { status: i < 2 ? "failed" : "done", executor: "cheap", model: null, report: "", backend: "direct", files: "" }; });
    log(ctx, "difficulty", { i, kind: "feature" }, { task_id: t.id });
  }
  const adapter: Classifier = { id: "ollama", external: false, async ask(state) {
    const i = JSON.parse(state).i;
    return { value: scores[i], confidence: 0.8, latencyMs: (i + 1) * 10, costUsd: 0.002 };
  } };
  const r = await runBench(ctx, config, set(adapter), options);
  expect(r.decisions.difficulty?.ollama).toEqual({ n: 4, errors: 0, labelled: 4, accuracy: 0.5, auc: 0.75,
    calibration: [
      { min: 0, max: 0.5, n: 0, confidence: null, accuracy: null },
      { min: 0.5, max: 0.6, n: 0, confidence: null, accuracy: null },
      { min: 0.6, max: 0.7, n: 0, confidence: null, accuracy: null },
      { min: 0.7, max: 0.8, n: 0, confidence: null, accuracy: null },
      { min: 0.8, max: 0.9, n: 4, confidence: 0.8, accuracy: 0.5 },
      { min: 0.9, max: 1, n: 0, confidence: null, accuracy: null },
    ], p50: 20, p95: 40, costPer1k: 2, agreement: 0.5,
    counterfactual: { cheapFailures: 2, avoided: 1, cheapSuccesses: 2, diverted: 1 } });
});

test("external adapter receives redacted states and task_kind loses planner_kind", async () => {
  const ctx = fakeCtx();
  log(ctx, "task_kind", { goal: `${ctx.home}/repo ${"x".repeat(400)}`, planner_kind: "debug" });
  let received = "";
  const adapter: Classifier = { id: "jev", external: true, async ask(s) { received = s; return { value: "feature", confidence: 1, latencyMs: 1 }; } };
  await runBench(ctx, cfg(), set(adapter), { ...options, adapters: ["jev"] });
  expect(JSON.parse(received).goal).toHaveLength(203);
  expect(JSON.parse(received).goal.startsWith("~/repo")).toBe(true);
  expect(received).not.toContain(ctx.home);
  expect(received).not.toContain("planner_kind");
});

test("since filtering keeps the boundary and drops older entries", async () => {
  const ctx = fakeCtx();
  log(ctx, "guard", { subagent_type: "old" }, { ts: ctx.now - 86401 });
  log(ctx, "guard", { subagent_type: "new" }, { ts: ctx.now - 86400 });
  const r = await runBench(ctx, cfg(), set(), { adapters: ["rules"], sinceS: 86400, limit: 500 });
  expect(r.decisions.guard?.rules.n).toBe(1);
});

test("deduplicates acted states keeping the last and caps each decision", async () => {
  const ctx = fakeCtx();
  log(ctx, "guard", { subagent_type: "one" });
  log(ctx, "guard", { subagent_type: "two" });
  log(ctx, "guard", { subagent_type: "shadow" }, { acted_on: false, shadow: true });
  log(ctx, "guard", { subagent_type: "none" }, { state: null });
  log(ctx, "guard", { subagent_type: "one" });
  log(ctx, "task_kind", { goal: "Add something" });
  const states: string[] = [];
  const adapter: Classifier = { id: "ollama", external: false, async ask(s, q) { states.push(s); return rulesClassifier.ask(s, q); } };
  const r = await runBench(ctx, cfg(), set(adapter), { ...options, limit: 1 });
  expect(r.decisions.guard?.ollama.n).toBe(1);
  expect(r.decisions.task_kind?.ollama.n).toBe(1);
  expect(states.some(s => s.includes("one"))).toBe(true);
  expect(states.some(s => s.includes("two"))).toBe(false);
});

test("no labels render as dash and unknown cost remains null", async () => {
  const ctx = fakeCtx();
  log(ctx, "guard", { subagent_type: "Explore" });
  const adapter: Classifier = { id: "ollama", external: false, async ask() { return { value: false, confidence: 0.9, latencyMs: 5 }; } };
  const r = await runBench(ctx, cfg(), set(adapter), options);
  expect(r.decisions.guard?.ollama.accuracy).toBeNull();
  expect(r.decisions.guard?.ollama.costPer1k).toBeNull();
  expect(renderBench(r)).toContain("-");
});

test("yesno labels produce AUC and errors or timeouts are counted without fallback", async () => {
  const ctx = fakeCtx();
  for (let i = 0; i < 3; i++) {
    const e = log(ctx, "guard", { i }, { answer: { value: i === 0, confidence: 1, latencyMs: 0 } });
    appendLabel(ctx, { type: "guard_feedback", event_id: e.id, correct: true });
  }
  const config = cfg(); config.bench.timeoutMs = 5;
  const adapter: Classifier = { id: "ollama", external: false, async ask(s) {
    const i = JSON.parse(s).i;
    if (i === 2) return new Promise(() => {});
    return { value: i === 0, probabilities: { yes: i === 0 ? 0.8 : 0.2 }, confidence: 0.8, latencyMs: 2, costUsd: 0 };
  } };
  const r = await runBench(ctx, config, set(adapter), options);
  expect(r.decisions.guard?.ollama).toMatchObject({ n: 3, errors: 1, labelled: 2, accuracy: 1, auc: 1, costPer1k: 0 });
});

test("findCommand bench is defined and command prints JSON with adapters rules", async () => {
  expect(findCommand("bench")).toBeDefined();
  const ctx = fakeCtx();
  log(ctx, "task_kind", { goal: "Add support" });
  const result = await findCommand("bench")!.run(["--adapters", "rules", "--json"], ctx);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).decisions.task_kind.rules.n).toBe(1);
  expect(result.err).toBe("");
});

test("bad flags exit 2", async () => {
  for (const args of [["--bad"], ["--decision", "bad"], ["--adapters", "bad"], ["--adapters", ""], ["--since", "bad"], ["--limit", "0"], ["--limit", "1.5"], ["--limit"], ["--json", "extra"]]) {
    expect((await findCommand("bench")!.run(args, fakeCtx())).code).toBe(2);
  }
});

test("invalid strategy and classifier configuration exit 2 with problems", async () => {
  for (const content of ["planner: bogus", "planner: codex\nproviders: {}\nclassifier:\n  unknown: true\n"]) {
    const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), content);
    const r = await findCommand("bench")!.run(["--adapters", "rules"], ctx);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid");
  }
});


test("observe-only primary difficulty samples retain truth while shadows are excluded", async () => {
  const ctx = fakeCtx();
  const t = createTask(ctx, { brief: { goal: "test", repo: "/repo" }, kind: "tests", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, t => { t.result = { status: "done", executor: "cheap", model: null, report: "", backend: "direct", files: "" }; });
  log(ctx, "difficulty", { kind: "tests" }, { task_id: t.id, acted_on: false });
  log(ctx, "difficulty", { kind: "debug" }, { task_id: t.id, acted_on: false, shadow: true });
  const config = cfg(); config.tiers = { cheap: "cheap" };
  const report = await runBench(ctx, config, set(), { ...options, adapters: ["rules"] });
  expect(report.decisions.difficulty?.rules).toMatchObject({ n: 1, labelled: 1 });
});

for (const redact of [true, false]) test(`all benchmark adapters receive identical states with redaction ${redact}`, async () => {
  const ctx = fakeCtx();
  log(ctx, "task_kind", { goal: ctx.home + "/" + "x".repeat(400), planner_kind: "debug" });
  const received: string[] = [];
  const adapter = (id: string, external: boolean): Classifier => ({ id, external, async ask(state, q) {
    received.push(state); return rulesClassifier.ask(state, q);
  } });
  const config = cfg(); config.bench.redact = redact;
  const report = await runBench(ctx, config, { rules: adapter("rules", false), ollama: adapter("ollama", false), jev: adapter("jev", true) }, { ...options, adapters: ["rules", "ollama", "jev"] });
  expect(received).toHaveLength(3);
  expect(new Set(received).size).toBe(1);
  expect(received[0].includes(ctx.home)).toBe(!redact);
  expect(received[0]).not.toContain("planner_kind");
  expect(JSON.parse(JSON.stringify(report)).redacted).toBe(redact);
  expect(renderBench(report)).toContain(`redacted: ${redact}`);
});
