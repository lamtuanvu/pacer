import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Strategy } from "../src/config/strategy";
import { CoreError } from "../src/core/errors";
import { buildCandidates } from "../src/dispatch/candidates";
import { decisionHash } from "../src/dispatch/engines";
import { buildModelInventory } from "../src/dispatch/inventory";
import { evaluateLadder } from "../src/dispatch/ladder";
import { collectObservations, statusObservationAdapter } from "../src/dispatch/observations";
import {
  openReadOnlyStore, reservationsReadOnly, runningTasksReadOnly, slotTasksReadOnly, storedObservationsReadOnly,
} from "../src/dispatch/readonly";
import { selectModel, targetTier, tierBuckets } from "../src/dispatch/tier-select";
import {
  dispatchConfigSchema, observationSchema,
  type Candidate, type DecisionRequest, type ModelRecord, type Observation, type ObservationScope,
} from "../src/dispatch/types";
import type { Status } from "../src/engine/status";
import { fakeCtx, tmpDir } from "./helpers";

// Golden differential for the `pacer-dispatch` crate: the same inputs go to the
// TypeScript functions and to `crates/dispatch/examples/dispatch_decision_diff.rs`,
// and the replies must match byte for byte (`JSON.stringify` text).

const root = join(import.meta.dir, "..");
let driver = "";

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-dispatch", "--example", "dispatch_decision_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString());
  driver = join(metadata.target_directory, "debug/examples/dispatch_decision_diff");
}, 600_000);

/** Raw request lines in, raw reply lines out. */
function rustLines(lines: string[]): string[] {
  const out = execFileSync(driver, [], { input: lines.join("\n") + "\n", encoding: "utf8" });
  return out.trimEnd().split("\n");
}

function rust(requests: object[]): string[] {
  return rustLines(requests.map(r => JSON.stringify(r)));
}

function expectSame(rustReplies: string[], tsReplies: unknown[]): void {
  expect(rustReplies).toEqual(tsReplies.map(r => JSON.stringify(r)));
}

const NOW = 1_800_000_000.25;

const config = dispatchConfigSchema.parse({
  discovery: { enabled: true, runners: ["codex"], models: ["gpt-x", "gpt-y"] },
  reservePct: 5,
});

const strategy = {
  name: "default",
  accounts: {
    claude: { name: "claude", kind: "claude" },
    work: { name: "work", kind: "claude" },
    codex: { name: "codex", kind: "codex" },
    ark: { name: "ark", kind: "endpoint", connection: { models: [{ id: "seed", tools: true, context: 256000 }] } },
  },
  runners: {
    "claude-code": {
      id: "claude-code", agent: "claude-code", account: "claude",
      models: [
        { id: "opus", tier: "frontier", strengths: ["review", "refactor"] },
        { id: "sonnet", tier: "medium", strengths: ["tests"], tools: true, context: 200000 },
      ],
    },
    "claude-code#work": { id: "claude-code#work", agent: "claude-code", account: "work" },
    codex: { id: "codex", agent: "codex", account: "codex", model: "gpt-5" },
    "opencode#ark": { id: "opencode#ark", agent: "opencode", account: "ark", models: [{ id: "pacer-ark/seed", tier: "small", strengths: [] }] },
    cursor: { id: "cursor", agent: "cursor", account: "cursor", enabled: false },
  },
  dispatch: config,
} as unknown as Strategy;

function obs(runner: string, account: string, method: Observation["method"], value: Observation["value"], extra: Partial<Observation> = {}, binding?: ObservationScope["binding"]): Observation {
  return observationSchema.parse({
    source: "fixture", scope: { runner, account, ...(binding ? { binding } : {}) }, method, state: "known",
    observedAt: NOW - 100, expiresAt: NOW + 600, ...(value ? { value } : {}), ...extra,
  });
}

const observations: Observation[] = [
  obs("codex", "codex", "models", { models: [{ id: "gpt-x", tier: "unknown", strengths: [] }, { id: "gpt-z", tier: "unknown", strengths: [] }] }),
  obs("claude-code", "claude", "capabilities", { tools: true, context: 400000 }, {}, { kind: "exact", id: "opus" }),
  obs("claude-code", "claude", "capabilities", { tools: false }, { observedAt: NOW - 50 }, { kind: "exact", id: "sonnet" }),
  obs("codex", "codex", "actual-model", { model: "gpt-5.1" }, {}, { kind: "exact", id: "gpt-5" }),
  obs("claude-code", "claude", "usage", { windows: [{ pool: "[\"claude\",\"5h\"]", usedPct: 30, hoursLeft: 2 }, { pool: "[\"claude\",\"week\"]", usedPct: 55.5, hoursLeft: 100 }], cost: 0.3 }),
  obs("claude-code", "claude", "health", { healthy: true }),
  obs("claude-code#work", "work", "health", { healthy: false }),
  obs("codex", "codex", "health", { healthy: true }),
  obs("codex", "codex", "usage", { unmetered: true, cost: 0 }),
  obs("opencode#ark", "ark", "health", { healthy: true }),
  obs("opencode#ark", "ark", "usage", { windows: [{ pool: "[\"ark\",\"day\"]", usedPct: 100 }] }),
  obs("codex", "codex", "capabilities", { tools: false }, { expiresAt: NOW - 1 }, { kind: "exact", id: "gpt-5" }),
  obs("codex", "codex", "usage", { windows: [{ pool: "[\"codex\",\"future\"]", usedPct: 99 }] }, { observedAt: NOW + 10 }),
];

const baseTask: DecisionRequest["task"] = {
  kind: null, difficulty: "standard", requirements: {}, preferences: { models: [], strengths: [] }, provenance: "request",
};

const tasks: DecisionRequest["task"][] = [
  baseTask,
  { ...baseTask, kind: "review", difficulty: "complex", requirements: { minTier: "medium", tools: true }, preferences: { models: ["sonnet"], strengths: ["review"] } },
  { ...baseTask, model: "sonnet" },
  { ...baseTask, difficulty: "simple", requirements: { context: 300000 } },
  { ...baseTask, difficulty: "simple", requirements: { tools: false } },
];

describe("decisionHash", () => {
  // Raw JSON text, parsed by each side: numbers (integral, fractional, exponent,
  // negative zero, beyond 2^53), string escapes, unicode and key order.
  const inputs = [
    "0", "-0", "-0.0", "1", "1.0", "100", "1e21", "1E21", "123456789012345680000", "1e20",
    "0.1", "1.5", "-2.5e-7", "1e-7", "0.000001", "5e-324", "1.7976931348623157e308", "9007199254740993", "-9007199254740993",
    "\"plain\"", "\"quote\\\" backslash\\\\ tab\\t nl\\n ctl\\u0001 del\\u007f\"", "\"é ～ 😀 \\u2028 \\u2029\"",
    "null", "true", "false", "[]", "{}", "[1,[2,[3.25]],{\"k\":-0}]",
    "{\"b\":1,\"a\":2,\"A\":3,\"_\":4,\"10\":5,\"2\":6,\"\":7,\"-1\":8}",
    "{\"😀\":1,\"～\":2,\"é\":3,\"e\":4,\"\\ud7ff\":5,\"\\uffff\":6,\"𝄞\":7}",
    "{\"z\":{\"y\":[1,{\"b\":0.5,\"a\":-0}],\"x\":null},\"a\":[[],{}],\"m\":\"\\u0000\"}",
  ];

  test("matches TypeScript bytes for numbers, unicode and key order", () => {
    const replies = rustLines(inputs.map(raw => `{"fn":"hash","value":${raw}}`));
    expectSame(replies, inputs.map(raw => decisionHash(JSON.parse(raw))));
  });

  test("matches the strategy, observation and request hashes a preview computes", () => {
    const inventory = buildModelInventory(strategy, observations, NOW);
    const values = [
      { dispatch: config, inventory, project: null },
      observations,
      { task: tasks[1], strategyHash: decisionHash({ dispatch: config }), observationRevision: decisionHash(observations), now: NOW },
    ];
    expectSame(rust(values.map(value => ({ fn: "hash", value }))), values.map(decisionHash));
  });
});

describe("model inventory and candidates", () => {
  test("inventory: declared, discovered, endpoint capabilities and observed evidence", () => {
    const cases: [Strategy, Observation[], number | null][] = [
      [strategy, observations, NOW],
      [strategy, [], null],
      [{ ...strategy, dispatch: { ...config, discovery: { ...config.discovery, enabled: false } } }, observations, NOW],
      [strategy, observations, NOW + 1000],
    ];
    expectSame(
      rust(cases.map(([s, o, now]) => ({ fn: "inventory", strategy: s, observations: o, now }))),
      cases.map(([s, o, now]) => buildModelInventory(s, o, now ?? undefined)),
    );
  });

  test("candidates: exclusions, headroom, burn, cost and pinned models across tasks", () => {
    const inventory = buildModelInventory(strategy, observations, NOW);
    const built = tasks.map(task => buildCandidates(strategy, task, inventory, observations, NOW));
    expect(new Set(built.flatMap(b => b.excluded.map(e => e.reason)))).toEqual(new Set([
      "Runner unavailable or disabled", "Task requirements not satisfied", "Different pinned model", "Runner not healthy", "Quota exhausted",
    ]));
    expectSame(rust(tasks.map(task => ({ fn: "candidates", strategy, task, inventory, observations, now: NOW }))), built);
  });

  test("observation parsing keeps schema order and rejects malformed values", () => {
    const values: unknown[] = [
      ...observations,
      { source: "s", scope: { runner: "r", account: "a" }, method: "models", state: "known", observedAt: 1, expiresAt: 2, value: { models: [{ id: "m" }] } },
      { source: "s", scope: { runner: "r", account: "a" }, method: "usage", state: "known", observedAt: 1, expiresAt: 2, value: { windows: [{ pool: "p", usedPct: 101 }] } },
      { source: "s", scope: { runner: "r", account: "a" }, method: "nope", state: "known", observedAt: 1, expiresAt: 2 },
    ];
    expectSame(
      rust(values.map(value => ({ fn: "parse", value }))),
      values.map(value => { const parsed = observationSchema.safeParse(value); return parsed.success ? parsed.data : null; }),
    );
  });
});

describe("ladder and tier choice", () => {
  const record = (id: string, tier: ModelRecord["tier"], headroom: number | null, extra: Partial<Candidate> = {}): Candidate => ({
    runner: id, account: id, executor: extra.executor ?? "codex", binding: { kind: "exact", id }, actualModel: null, tier,
    strengths: [], provenance: "declared", id: JSON.stringify([id, { kind: "exact", id }]), poolIds: [], headroom,
    burn: null, cost: null, capacityKnown: headroom !== null, ...extra,
  });
  const tiered = [
    record("small", "small", 90),
    record("mid", "medium", 15, { strengths: ["tests"] }),
    record("mid-2", "medium", 40, { cost: 2, burn: 1.5 }),
    record("big", "frontier", 60, { cost: 1, burn: 0.25, executor: "claude-code", strengths: ["review"], tools: true }),
    record("odd", "unknown", null),
    record("learned", "medium", 40, { learnedFit: { successRate: 0.875, sampleCount: 24, uncertainty: 0.125 } }),
    record("default", "unknown", 70, { binding: { kind: "executor-default" }, id: JSON.stringify(["default", { kind: "executor-default" }]) }),
  ];
  const configs = [
    config,
    dispatchConfigSchema.parse({ reservePct: 20, comfortablePct: 30 }),
    dispatchConfigSchema.parse({ tierTargets: { simple: "medium", standard: "frontier", complex: "frontier" } }),
    dispatchConfigSchema.parse({
      steps: [
        { id: "reviewers", match: { kind: "review" }, candidates: { executors: ["claude-code"] }, rank: ["preference", "task-fit"] },
        { id: "cheap", candidates: { models: ["mid-2", "big", "learned"] }, capacity: "usable", rank: ["cheapest-first", "burn-before-reset"] },
        { id: "anything", capacity: "unknown", prefer: { models: ["odd", "small"], strengths: ["tests"] }, rank: ["spare-capacity", "task-fit"] },
      ],
    }),
    dispatchConfigSchema.parse({ steps: [{ id: "strict", require: { minTier: "frontier", tools: true } }] }),
  ];
  const requestTasks: DecisionRequest["task"][] = [
    ...tasks,
    { ...baseTask, kind: "review" },
    { ...baseTask, model: "odd" },
    { ...baseTask, model: "missing" },
    { ...baseTask, difficulty: "complex", requirements: { minTier: "frontier" } },
  ];

  test("ranks hand-written candidates across tiers, steps, fallbacks and exclusions", () => {
    // Subsets without a target-tier candidate exercise the upward and unknown-tier fallbacks.
    const subsets = [tiered, tiered.slice(0, 2), [tiered[0]!, tiered[3]!, tiered[4]!], [tiered[0]!, tiered[4]!, tiered[6]!], []];
    const cases = configs.flatMap(c => requestTasks.flatMap(task => subsets.map(candidates => ({
      request: { task, candidates } as unknown as DecisionRequest, config: c,
    }))));
    expect(cases.length).toBe(225);
    const proposals = cases.map(c => evaluateLadder(c.request, c.config));
    const outcomes = new Set(proposals.map(p => p.state === "ranked" ? p.tier!.reason : p.state));
    expect(outcomes).toEqual(new Set(["target-match", "upward-fallback", "unknown-tier-fallback", "explicit-override", "no-match"]));
    expect(new Set(proposals.flatMap(p => p.state === "ranked" ? [p.step] : []))).toEqual(new Set(
      ["capable-with-headroom", "usable-fallback", "reviewers", "cheap", "anything", "strict"],
    ));
    expect(proposals.some(p => p.state === "ranked" && p.skipped.length > 0 && p.choices.length > 1)).toBe(true);
    expectSame(rust(cases.map(c => ({ fn: "ladder", ...c }))), proposals);
  });

  test("ranks candidates built from the shared inventory and observations", () => {
    const inventory = buildModelInventory(strategy, observations, NOW);
    const cases = configs.flatMap(c => tasks.map(task => ({
      request: { task, candidates: buildCandidates(strategy, task, inventory, observations, NOW).candidates } as unknown as DecisionRequest,
      config: c,
    })));
    expectSame(rust(cases.map(c => ({ fn: "ladder", ...c }))), cases.map(c => evaluateLadder(c.request, c.config)));
  });

  test("targetTier, tierBuckets and selectModel", () => {
    const targets = configs[2]!.tierTargets;
    const tierCases = (["simple", "standard", "complex"] as const).flatMap(difficulty =>
      [undefined, "small", "medium", "frontier"].map(minTier => ({ difficulty, targets, minTier })));
    expectSame(
      rust(tierCases.map(c => ({ fn: "targetTier", ...c }))),
      tierCases.map(c => ({ target: targetTier(c.difficulty, c.targets, c.minTier as "small" | undefined) })),
    );

    const items = buildModelInventory(strategy, observations, NOW);
    const bucketCases = ["small", "medium", "frontier"] as const;
    expectSame(rust(bucketCases.map(target => ({ fn: "tierBuckets", items, target }))), bucketCases.map(target => tierBuckets(items, target)));

    const options = [
      { difficulty: "standard" as const, targets: config.tierTargets },
      { difficulty: "complex" as const, targets: config.tierTargets },
      { difficulty: "simple" as const, targets: config.tierTargets },
      { difficulty: "simple" as const, targets: config.tierTargets, minTier: "medium" as const },
      { difficulty: "standard" as const, targets: config.tierTargets, pin: "sonnet" },
      { difficulty: "standard" as const, targets: config.tierTargets, pin: "nope" },
      { difficulty: "complex" as const, targets: config.tierTargets, usable: ["codex", "claude-code#work"], fixedExecutor: true, defaultModel: "gpt-5" },
      { difficulty: "complex" as const, targets: config.tierTargets, usable: ["claude-code#work"], fixedExecutor: true },
      { difficulty: "complex" as const, targets: config.tierTargets, usable: ["codex"] },
      { difficulty: "complex" as const, targets: config.tierTargets, usable: [] as string[] },
      { difficulty: "simple" as const, targets: config.tierTargets, usable: ["claude-code"] },
    ];
    const choices = options.map(o => selectModel(items, { ...o, ...(o.usable ? { isUsable: (r: ModelRecord) => o.usable!.includes(r.runner) } : {}) }));
    expect(new Set(choices.map(c => c.reason))).toEqual(new Set([
      "target-match", "upward-fallback", "unknown-tier-fallback", "explicit-override", "executor-fixed-below-target", "no-eligible",
    ]));
    expectSame(rust(options.map(o => ({ fn: "select", records: items, options: o }))), choices);
  });
});

describe("status observation adapter", () => {
  const status = {
    generatedAt: NOW,
    providers: [
      { id: "claude-code", installed: true, usage: "metered", windows: [
        { name: "5h", usedPct: 42, resetsAt: NOW + 5400, stale: false, rolled: false },
        { name: "week", usedPct: 10.5, resetsAt: null, stale: false, rolled: false },
      ] },
      { id: "codex", installed: true, usage: "unmetered", windows: [] },
      { id: "partial", installed: true, usage: "metered", windows: [
        { name: "5h", usedPct: null, resetsAt: NOW + 60, stale: false },
        { name: "day", usedPct: 20, resetsAt: NOW + 60, rolled: true },
      ] },
      { id: "blocked", installed: true, usage: "metered", blockedReason: "paused", windows: [{ name: "5h", usedPct: 5, resetsAt: NOW + 30 }] },
      { id: "ineligible", installed: true, usage: "metered", eligibility: { state: "ineligible" }, windows: [] },
      { id: "missing", installed: false, usage: "metered", windows: [] },
      { id: "stale", installed: true, stale: true, usage: "metered", windows: [] },
      { id: "past", installed: true, usage: "metered", windows: [{ name: "5h", usedPct: 1, resetsAt: NOW - 3600 }] },
      { id: "full", installed: true, usage: "metered", windows: [{ name: "5h", usedPct: 130, resetsAt: NOW + 30 }] },
    ],
    accounts: [
      { name: "claude", capturedAt: NOW - 30 },
      { name: "codex", capturedAt: null },
      { name: "stale-account", capturedAt: NOW - 5, stale: true },
      { name: "future", capturedAt: NOW + 30 },
      { name: "old", capturedAt: NOW - 90 },
    ],
  } as unknown as Status;
  const scopes: ObservationScope[] = [
    { runner: "claude-code", account: "claude" },
    { runner: "claude-code", account: "claude", binding: { kind: "exact", id: "opus" } },
    { runner: "codex", account: "codex" },
    { runner: "partial", account: "claude" },
    { runner: "blocked", account: "claude" },
    { runner: "ineligible", account: "claude" },
    { runner: "missing", account: "claude" },
    { runner: "stale", account: "claude" },
    { runner: "claude-code", account: "stale-account" },
    { runner: "claude-code", account: "future" },
    { runner: "claude-code", account: "old" },
    { runner: "past", account: "claude" },
    { runner: "full", account: "claude" },
    { runner: "unknown-runner", account: "nobody" },
  ];

  test("collects the cache-only status the way collectObservations does", async () => {
    // NOW + 30 is the exact expiry of the claude reading (captured 30 s before NOW).
    const nows = [NOW, NOW + 30, NOW + 45, NOW + 7200];
    const ts = [];
    for (const now of nows) ts.push(await collectObservations(fakeCtx({ now }), [statusObservationAdapter(status)], scopes));
    expect(new Set(ts.flat().map(o => o.state))).toEqual(new Set(["known", "unknown", "unsupported", "error"]));
    expectSame(rust(nows.map(now => ({ fn: "status", status, scopes, now }))), ts);
  });
});

describe("read-only task store", () => {
  function seed(home: string, sql: string): void {
    mkdirSync(join(home, "state"), { recursive: true });
    const db = new Database(join(home, "state", "tasks.db"));
    db.exec(sql);
    db.close();
  }
  const valid = (observedAt: number, expiresAt: number) => JSON.stringify({
    expiresAt, observedAt, value: { healthy: true }, state: "known", method: "health", scope: { account: "a", runner: "r" }, source: "s",
  }).replaceAll("'", "''");

  function ts(pacerHome: string, strict: boolean): unknown {
    try {
      const store = openReadOnlyStore(fakeCtx({ pacerHome }), strict);
      try {
        return {
          available: store.available, immutable: store.immutable,
          running: runningTasksReadOnly(store), slots: slotTasksReadOnly(store),
          observations: storedObservationsReadOnly(store, NOW), reservations: reservationsReadOnly(store),
        };
      } finally { store.close(); }
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      return { error: { code: error.code, message: error.message } };
    }
  }

  test("reads tasks, observations and reservations without writing", () => {
    const full = tmpDir();
    seed(full, `
      CREATE TABLE tasks(id TEXT PRIMARY KEY, state TEXT, record TEXT);
      INSERT INTO tasks VALUES ('t1','running','{"id":"t1","b":1,"a":2}'), ('t2','needs_input','{"id":"t2"}'),
        ('t3','done','{"id":"t3"}'), ('t4','running','not json'), ('t5','running',NULL), ('t6','running',7);
      CREATE TABLE work_observations(id TEXT PRIMARY KEY, at REAL, data TEXT);
      INSERT INTO work_observations VALUES ('o1', 3, '${valid(NOW - 10, NOW + 10)}'), ('o2', 2, '${valid(NOW - 10, NOW - 1)}'),
        ('o3', 1, '{"broken":'), ('o4', 4, '${valid(NOW - 20, NOW + 20)}');
      CREATE TABLE work_reservations(pools TEXT, estimate REAL);
      INSERT INTO work_reservations VALUES ('["p1","p2"]', 2.5), ('nope', 1), ('5', 3), (NULL, NULL);
    `);
    const noTasks = tmpDir();
    seed(noTasks, "CREATE TABLE other(x);");
    const garbage = tmpDir();
    mkdirSync(join(garbage, "state"), { recursive: true });
    writeFileSync(join(garbage, "state", "tasks.db"), "not a database");
    const missing = tmpDir();

    const cases = [[full, false], [full, true], [noTasks, false], [garbage, false], [garbage, true], [missing, false], [missing, true]] as const;
    const expected = cases.map(([pacerHome, strict]) => ts(pacerHome, strict));
    expect(expected[0]).toMatchObject({ available: true, immutable: false });
    expect(expected[4]).toHaveProperty("error.code", "conflict");
    expectSame(rust(cases.map(([pacerHome, strict]) => ({ fn: "readonly", pacerHome, strict, now: NOW }))), expected);
    expect(existsSync(join(missing, "state"))).toBe(false);
  });
});
