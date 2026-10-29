import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeHooks } from "../src/classify/active";
import { defaultHooks } from "../src/classify/hooks";
import { expect, test } from "bun:test";
import { makeClassifierHooks, countRepoFiles } from "../src/classify/classifier-hooks";
import { readDecisions } from "../src/classify/log";
import { rulesClassifier } from "../src/classify/rules";
import type { AdapterSet } from "../src/classify/registry";
import { validateStrategy } from "../src/config/strategy";
import type { TaskResult } from "../src/tasks/types";
import { createTask } from "../src/tasks/store";
import { runTask } from "../src/tasks/runner";
import { fakeCtx } from "./helpers";

const strategy = (classifier: Record<string, unknown> = {}) => validateStrategy({
  planner: "claude-code", providers: { codex: { usage: "reactive" }, cursor: {}, cheap: { via: "opencode", model: "local/model", usage: "unmetered" } },
  routing: [{ default: ["cheap", "codex", "cursor"] }], classifier,
}, "/fake");
const task = (ctx: ReturnType<typeof fakeCtx>, kind: string | null = null) => createTask(ctx, {
  brief: { goal: "write tests", repo: "/repo" }, kind, requestedExecutor: null, timeoutS: 60,
});
const result: TaskResult = { status: "done", executor: "codex", model: null, report: "done", files: "", backend: "direct" };
const adapters = (value: string | number | boolean, confidence = 0.9): AdapterSet => ({
  rules: rulesClassifier,
  ollama: { id: "ollama", external: false, ask: async () => ({ value, confidence, latencyMs: 0 }) },
  jev: { id: "jev", external: true, ask: async () => { throw new Error("unused"); } },
});

for (const [label, loadStrategy] of [
  ["unconfigured", () => strategy()],
  ["invalid config", () => strategy({ default: "unknown" })],
  ["missing strategy", () => { throw new Error("missing"); }],
] as const) {
  test(`${label} is observe-only and logs decisions`, async () => {
    const ctx = fakeCtx(); const t = task(ctx);
    const hooks = makeClassifierHooks({ loadStrategy });
    expect(await hooks.taskKind(ctx, t)).toBeNull();
    expect(await hooks.filterExecutors(ctx, t, ["cheap", "codex"], strategy())).toEqual(["cheap", "codex"]);
    expect(await hooks.resultCheck(ctx, t, result)).toEqual({ pass: true, confidence: 0.5, adapter: "rules" });
    const logs = readDecisions(ctx);
    expect(logs.map(e => e.decision)).toEqual(["task_kind", "difficulty", "result_check"]);
    expect(logs.slice(0, 2).every(e => !e.acted_on && e.adapter === "rules")).toBe(true);
  });
}

test("configured ollama fake server decides kind", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ choices: [{ message: { content: '{"choice":"docs","confidence":0.9}' } }] }) });
  try {
    const ctx = fakeCtx();
    const hooks = makeClassifierHooks({ loadStrategy: () => strategy({ default: "ollama", adapters: { ollama: { base_url: `http://127.0.0.1:${server.port}/v1` } } }) });
    expect(await hooks.taskKind(ctx, task(ctx))).toBe("docs");
    expect(readDecisions(ctx)[0]).toMatchObject({ adapter: "ollama", acted_on: true });
  } finally { server.stop(true); }
});

for (const verify of [false, true]) test(`verify_kind ${verify} controls tagged tasks`, async () => {
  const ctx = fakeCtx(); const t = task(ctx, "tests");
  const hooks = makeClassifierHooks({ loadStrategy: () => strategy({ default: "ollama", decisions: { task_kind: { verify_kind: verify } } }), adapters: () => adapters("docs") });
  expect(await hooks.taskKind(ctx, t)).toBe(verify ? "docs" : "tests");
  expect(readDecisions(ctx)[0]).toMatchObject({ adapter: verify ? "ollama" : "rules", acted_on: true });
});

test("low confidence falls back to rules", async () => {
  const ctx = fakeCtx();
  const hooks = makeClassifierHooks({ loadStrategy: () => strategy({ default: "ollama" }), adapters: () => adapters("docs", 0.1) });
  expect(await hooks.taskKind(ctx, task(ctx))).toBe("tests");
  expect(readDecisions(ctx)[0]).toMatchObject({ fallback: true, fallback_from: "ollama", adapter: "rules" });
});

for (const [score, ranked, expected] of [
  [0.4, ["cheap", "cursor", "codex"], ["cursor", "codex"]],
  [0.6, ["cheap", "codex"], ["cheap", "codex"]],
  [0.4, ["cheap"], ["cheap"]],
] as const) test(`difficulty ${score} filters ${ranked.join(",")}`, async () => {
  const ctx = fakeCtx(); const s = strategy({ default: "ollama", decisions: { difficulty: { max_for_cheap: 0.6 } } });
  const hooks = makeClassifierHooks({ loadStrategy: () => s, adapters: () => adapters(score), repoFiles: async () => 42 });
  expect(await hooks.filterExecutors(ctx, task(ctx), [...ranked], s)).toEqual([...expected]);
  expect(readDecisions(ctx)[0]).toMatchObject({ acted_on: true });
});

test("kind and difficulty are cached per task including concurrent calls", async () => {
  const ctx = fakeCtx(); const t = task(ctx); const s = strategy({ default: "ollama" });
  const hooks = makeClassifierHooks({ loadStrategy: () => s, adapters: () => adapters("docs") });
  expect(await Promise.all([hooks.taskKind(ctx, t), hooks.taskKind(ctx, t)])).toEqual(["docs", "docs"]);
  await Promise.all([hooks.filterExecutors(ctx, t, ["cheap"], s), hooks.filterExecutors(ctx, t, ["codex"], s)]);
  expect(readDecisions(ctx).map(e => e.decision)).toEqual(["task_kind", "difficulty"]);
  await hooks.taskKind(ctx, task(ctx));
  expect(readDecisions(ctx)).toHaveLength(3);
});

test("resultCheck uses classifier and rules acceptance", async () => {
  const ctx = fakeCtx(); const t = task(ctx);
  const hooks = makeClassifierHooks({ loadStrategy: () => strategy({ default: "ollama" }), adapters: () => adapters(false) });
  expect(await hooks.resultCheck(ctx, t, result)).toEqual({ pass: false, confidence: 0.9, adapter: "ollama" });
  const rules = makeClassifierHooks({ loadStrategy: () => strategy() });
  // An empty tail (an exit code with no output, e.g. a SIGPIPE-killed `| grep -q`) gets a lower confidence (issue #450).
  expect(await rules.resultCheck(ctx, t, { ...result, status: "partial", acceptance: { cmd: "test", passed: false, tail: "" } })).toEqual({ pass: false, confidence: 0.6, adapter: "rules" });
  expect(await rules.resultCheck(ctx, t, { ...result, status: "partial", acceptance: { cmd: "test", passed: false, tail: "2 failed" } })).toEqual({ pass: false, confidence: 0.95, adapter: "rules" });
});

for (const mode of ["off", "non-rules", "rules", "error", "execution", "fallback"] as const) test(`guard ${mode}`, async () => {
  const ctx = fakeCtx({ env: mode === "off" ? { PACER: "off" } : {} });
  const hooks = makeClassifierHooks({
    loadStrategy: () => strategy({ default: mode === "rules" ? "rules" : "ollama" }),
    adapters: () => { if (mode === "error") throw new Error("adapter failed"); return adapters(mode === "execution", mode === "fallback" ? 0.1 : 0.9); },
  });
  const opinion = await hooks.guard(ctx, { subagentType: "general-purpose", prompt: "research" });
  if (mode === "non-rules") expect(opinion).toMatchObject({ allow: true, adapter: "ollama", confidence: 0.9 });
  else expect(opinion).toBeNull();
  if (mode === "off") expect(readDecisions(ctx)).toEqual([]);
});

test("countRepoFiles invokes git and fails open", async () => {
  const ctx = fakeCtx({ run: async (argv) => {
    expect(argv).toEqual(["git", "-C", "/repo", "ls-files"]);
    return { code: 0, stdout: "a\nb\n", stderr: "" };
  } });
  expect(await countRepoFiles(ctx, "/repo")).toBe(2);
  expect(await countRepoFiles(fakeCtx(), "/repo")).toBeNull();
});

test("runTask with injected classifier deps records check and logs all decisions", async () => {
  const ctx = fakeCtx(); const s = strategy(); const t = task(ctx);
  const hooks = makeClassifierHooks({ loadStrategy: () => s, adapters: () => adapters(false), repoFiles: async () => 10 });
  const completed = await runTask(ctx, t.id, {
    loadStrategy: () => s, hooks,
    computeStatus: async () => ({ generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true, executors: { ranked: [], excluded: [] }, providers: Object.keys(s.providers).map(id => ({ id, usage: "reactive", windows: [], binding: null, verdict: "OK", installed: true, stale: false })) }),
    runAttempt: async (_ctx, cfg) => ({ exec: { code: 0, stdout: "done", stderr: "", timedOut: false }, report: "done", attempt: { executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" } }),
    verifyRepo: async () => ({ files: "a" }),
  });
  expect(completed.result).toMatchObject({ status: "done", check: { pass: true, adapter: "rules" } });
  expect(readDecisions(ctx).map(e => e.decision)).toEqual(["task_kind", "difficulty", "result_check"]);
});


for (const mode of ["observe", "filter", "shadow"] as const) test(`repo file probe only runs for difficulty filter or shadows: ${mode}`, async () => {
  const ctx = fakeCtx();
  let probes = 0;
  const s = strategy(mode === "filter" ? { decisions: { difficulty: { max_for_cheap: 0.6 } } } : mode === "shadow" ? { shadow: ["ollama"] } : {});
  const hooks = makeClassifierHooks({ loadStrategy: () => s, adapters: () => adapters(0.8), repoFiles: async () => { probes++; return 10; } });
  await hooks.filterExecutors(ctx, task(ctx), ["cheap", "codex"], s);
  expect(probes).toBe(mode === "observe" ? 0 : 1);
});

// These eviction tests exercise 500 real decision-log writes; allow disk contention.
for (const method of ["kind", "difficulty"] as const) test(`${method} cache evicts least recently used tasks after 500`, async () => {
  const ctx = fakeCtx(); const s = strategy({ default: "ollama" });
  let calls = 0;
  const set = adapters(method === "kind" ? "docs" : 0.8);
  const ask = set.ollama.ask;
  set.ollama.ask = async (state, q) => { calls++; return ask(state, q); };
  const hooks = makeClassifierHooks({ loadStrategy: () => s, adapters: () => set });
  const base = task(ctx);
  const invoke = (id: string) => method === "kind"
    ? hooks.taskKind(ctx, { ...base, id })
    : hooks.filterExecutors(ctx, { ...base, id }, ["cheap", "codex"], s);
  for (let i = 0; i < 500; i++) await invoke(String(i));
  await invoke("0");
  await invoke("500");
  await invoke("0");
  expect(calls).toBe(501);
  await invoke("1");
  expect(calls).toBe(502);
}, 30000);

test("activeHooks without classifier preserve default kind and executor lists", async () => {
  const ctx = fakeCtx();
  const raw = { planner: "claude-code", providers: { codex: {}, cheap: { via: "opencode", model: "local/model", usage: "unmetered" } }, routing: [{ default: ["cheap", "codex"] }] };
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
  const s = validateStrategy(raw, "/fake");
  for (const kind of [null, "tests"]) {
    const t = task(ctx, kind);
    expect(await activeHooks.taskKind(ctx, t)).toBe(await defaultHooks.taskKind(ctx, t));
    expect(await activeHooks.filterExecutors(ctx, t, ["cheap", "codex"], s)).toEqual(await defaultHooks.filterExecutors(ctx, t, ["cheap", "codex"], s));
  }
});

test("hook caches never mix tasks from different pacer homes that share an id", async () => {
  const hooks = makeClassifierHooks({ loadStrategy: () => strategy() });
  const a = fakeCtx(), b = fakeCtx();
  const first = task(a, null);
  const twin = { ...first, kind: "tests" };
  expect(await hooks.taskKind(a, first)).toBeNull();
  expect(await hooks.taskKind(b, twin)).toBe("tests");
});
