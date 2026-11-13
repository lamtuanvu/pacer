import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifierConfig } from "../src/config/classifier";
import { resolveRunner } from "../src/config/runner-id";
import { loadStrategy, validateStrategy, type Strategy } from "../src/config/strategy";
import { previewDispatch, type ReadOnlyDispatch } from "../src/core/dispatch";
import { explainDispatch, type RouteExplanation } from "../src/core/dispatch-explain";
import { pause, readPause } from "../src/core/pause";
import { projectSnapshot, resolvePolicyRepoInputReadOnly } from "../src/core/project-policy";
import { explainInputSchema } from "../src/dispatch/explain-input";
import { evaluateLadder } from "../src/dispatch/ladder";
import { applyLearnedFit, dispatchSettingsHash, readOnlyReviewReader } from "../src/dispatch/learning";
import { openReadOnlyStore, slotTasksReadOnly } from "../src/dispatch/readonly";
import { exclusionReason, reason, REASON_CODES, type ReasonFacts } from "../src/dispatch/reasons";
import { dispatchConfigSchema, type Candidate, type DecisionRequest } from "../src/dispatch/types";
import { balanceByLoad } from "../src/engine/balance";
import { conversationFallback, rankExecutors } from "../src/engine/rank";
import { slotBlock, slotUse } from "../src/engine/slots";
import type { Status } from "../src/engine/status";
import { executorExclusion } from "../src/executors/availability";
import { blockExecutor } from "../src/executors/blocked";
import { readHostReachability, remoteExclusion } from "../src/remote/eligibility";
import { draftStrategy } from "../src/strategy/service";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { pairStrategy } from "./fixtures/balance-pair";
import { fakeCtx, tmpDir } from "./helpers";

// Golden differential for the `pacer-dispatch` explanation library: learned fit,
// reason codes and the route explanation builders. The same inputs go to the
// TypeScript functions and to `crates/dispatch/examples/dispatch_decision_diff.rs`,
// and the replies must match byte for byte (`JSON.stringify` text).

const root = join(import.meta.dir, "..");
let driver = "";

beforeAll(() => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-dispatch", "--example", "dispatch_decision_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString());
  driver = join(metadata.target_directory, "debug/examples/dispatch_decision_diff");
}, 600_000);

function rust(requests: object[]): string[] {
  const out = execFileSync(driver, [], { input: requests.map(r => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8" });
  return out.trimEnd().split("\n");
}

/** Replies paired with labels, so a mismatch names its case. */
function expectSame(labels: string[], rustReplies: string[], tsReplies: unknown[]): void {
  expect(labels.map((l, i) => [l, rustReplies[i]])).toEqual(labels.map((l, i) => [l, JSON.stringify(tsReplies[i])]));
}

const NOW = 1_800_000_000.25;

describe("reasons", () => {
  test("every code's text and facts match TypeScript", () => {
    const factSets: ReasonFacts[] = [
      {},
      {
        reason: "budget band 1 — ホスト 😀", stepId: "capable-with-headroom", kind: "review", headroomPct: 14.5, pacePct: 40, executor: "codex#work",
        resetsAt: "2026-11-14 09:00", of: "opencode#ark", used: 2.5, limit: -2.5, host: "build-01", agent: "claude-code",
        until: 1_800_003_600.25, validation: "timeout", requested: "cursor", samples: 0.49999999999999994, needed: 1e21,
        engine: "plugin:engine", fields: "requirements, model", error: "invalid_config", policy: "priority", score: 3,
      },
      { kind: "", headroomPct: -0.5, used: "3", limit: null, resetsAt: 0, agent: "", until: null, samples: -0, needed: 1e-7, stepId: "", headroomPct2: true },
      { kind: true, headroomPct: 99.5, used: 4503599627370495.5, limit: 2.5e-324, resetsAt: 1_800_000_000, agent: false, until: 0, reason: null, executor: false },
    ];
    const cases = REASON_CODES.flatMap(code => factSets.flatMap((facts, i) => [
      { code, outcome: (["pass", "fail", "info"] as const)[i % 3], facts, ...(i % 2 ? { subject: `runner-${i} é` } : {}) },
      ...(i === 1 ? [{ code, outcome: "fail" as const, facts, subject: "x", text: "Custom ✓ text." }] : []),
    ]));
    expect(new Set(cases.map(c => c.code)).size).toBe(49);
    expectSame(cases.map(c => `${c.code}/${JSON.stringify(c.facts).length}`), rust(cases.map(c => ({ fn: "reason", ...c }))),
      cases.map(c => reason(c.code, c.outcome, c.facts, c.subject, c.text)));
  });

  test("exclusion texts map to the same codes and facts", () => {
    const texts = [
      "planner", "disabled", "not configured", "Blocked by you", "exhausted", "not installed", "Quota exhausted",
      "Runner unavailable or disabled", "Runner not healthy", "Task requirements not satisfied", "Different pinned model",
      "remote runners need a new worktree", "scoped child delegation requires local grant transport",
      "host build-01 reachability unknown (cached preview)", "host a reachability unknown b reachability unknown tail",
      "host  reachability unknown", "host x\ny reachability unknown", "host ホスト😀 reachability unknown",
      "host build-01 unreachable", "host  unreachable", "host a b unreachable", "host a\nb unreachable", "host x unreachable!",
      "build-01 paused", " paused", "paused", "a\nb paused", "ホスト paused", "host h paused",
      "repo not set up on build-01 (no checkout)", "repo not set up on h\u00a0x", "repo not set up on \ufeffx", "repo not set up on h\u0085x",
      "repo not set up on ", "repo not set up on 😀",
      "this machine busy (3/4)", "this machine busy (3/4) ", "this machine busy (3/x)", "this machine busy (007/10)",
      "codex busy (1/2)", "a busy (1/2) busy (3/4)", "x busy (99999999999999999999999/1)", " busy (1/2)", "line\nbreak busy (1/2)",
      "codex#work busy (2/2)", "build-01 busy (0/0)", "Native delegation control is not available", "NATIVE", "could not verify the version",
      "No native control adapter for cursor", "Executor account is unavailable", "executor ACCOUNT is unavailable",
      "Not working: signed out", "not working", "Not workin", "Something else entirely", "",
    ];
    const cases: { subject: string; text: string; eligibility?: { state: string; reasons?: { code: string }[] } }[] = [
      ...texts.map((text, i) => ({ subject: `runner-${i}`, text })),
      { subject: "codex", text: "budget used up", eligibility: { state: "ineligible", reasons: [{ code: "other" }, { code: "budget_exhausted" }] } },
      { subject: "codex", text: "signed out", eligibility: { state: "ineligible", reasons: [{ code: "signed_out" }] } },
      { subject: "codex", text: "signed out", eligibility: { state: "ineligible" } },
      { subject: "codex", text: "disabled", eligibility: { state: "ineligible" } },
      { subject: "codex", text: "codex busy (1/2)", eligibility: { state: "eligible" } },
    ];
    const ts = cases.map(c => exclusionReason(c.subject, c.text, c.eligibility));
    expect(new Set(ts.map(r => r.code))).toEqual(new Set([
      "planner_account", "runner_disabled", "not_configured", "blocked_by_user", "quota_exhausted", "not_installed", "runner_unhealthy",
      "requirements_not_met", "pinned_to_other_model", "needs_new_worktree", "local_grant_required", "host_reachability_unknown",
      "host_unreachable", "host_paused", "repo_not_on_host", "machine_busy", "executor_busy", "enforcement_uncertified", "unavailable",
      "ineligible", "other_exclusion",
    ]));
    expectSame(cases.map(c => JSON.stringify(c.text)), rust(cases.map(c => ({ fn: "exclusion", ...c }))), ts);
  });
});

/** A strategy with two equal codex runners (for ties), claude-code and cursor. */
const learningStrategy = (learning: object | undefined) => {
  const s = validateStrategy({
    planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" }, b: { kind: "codex", home: "/tmp/pacer-parity-b" }, cursor: { kind: "cursor" } },
    runners: { codex: { models: [{ id: "gpt-x", tier: "medium" }] }, "codex#b": { models: [{ id: "gpt-x", tier: "medium" }] },
      cursor: { models: [{ id: "mid", tier: "medium" }] } },
  }, "learning");
  s.dispatch = dispatchConfigSchema.parse(learning === undefined ? {} : { learning });
  return s;
};

describe("learned fit", () => {
  const strategy = learningStrategy({ enabled: true, minSamples: 20, maxAgeDays: 90 });
  const candidate = (runner: string, model: string | null, executor = "codex"): Candidate => ({
    runner, account: strategy.runners[runner]?.account ?? runner, executor, binding: { kind: "exact", id: model ?? "default" }, actualModel: model,
    tier: "medium", strengths: [], provenance: "declared", id: JSON.stringify([runner, { kind: "exact", id: model ?? "default" }]), poolIds: [],
    headroom: 50, burn: null, cost: null, capacityKnown: true,
  });
  const candidates = [candidate("codex", "gpt-x"), candidate("codex#b", "gpt-x"), candidate("cursor", "mid", "cursor"), candidate("codex", null), candidate("claude-code", "opus", "claude-code")];
  const task = { kind: "debug", difficulty: "standard" };
  const oldest = NOW - 90 * 86400;

  function review(runner: string, model: string | null, extra: Record<string, unknown> = {}) {
    return { taskId: "t", attempt: 1, repo: "/repo/a", kind: "debug", difficulty: "standard", runner, model, settings: dispatchSettingsHash(strategy, runner),
      accepted: true, durationS: 30, usagePct: 2.5, at: NOW - 100, provenance: "human", ...extra };
  }
  function seed(home: string, rows: unknown[], extra = ""): void {
    mkdirSync(join(home, "state"), { recursive: true });
    const db = new Database(join(home, "state", "tasks.db"));
    db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, state TEXT, record TEXT);
      CREATE TABLE work_reviews(task_id TEXT, attempt INTEGER, at REAL, provenance TEXT, data);
      CREATE TABLE work_learning_exclusions(repo TEXT PRIMARY KEY);
      CREATE TABLE work_learning_reset(repo TEXT PRIMARY KEY, at REAL NOT NULL);
      INSERT INTO work_learning_exclusions VALUES ('/repo/excluded');
      INSERT INTO work_learning_reset VALUES ('/repo/reset', ${NOW - 1000});${extra}`);
    const insert = db.query("INSERT INTO work_reviews VALUES (?,?,?,?,?)");
    rows.forEach((row, i) => insert.run(`t${i}`, 1, NOW, "human", typeof row === "string" || typeof row === "number" ? row : JSON.stringify(row)));
    db.close();
  }
  // codex: 20 comparable reviews with mixed truthy and falsy acceptance, one exactly at the age limit.
  const accepted: unknown[] = [true, 1, "yes", false, 0, "", null, true, true, false, true, true, true, false, true, true, 2, true, false, true];
  const codex = accepted.map((value, i) => review("codex", "gpt-x", { accepted: value, at: i === 0 ? oldest : NOW - 100 - i }));
  const rows: unknown[] = [
    ...codex,
    // the same history for the second codex runner: equal learned fit, so the ladder breaks the tie by id
    ...codex.map(r => ({ ...(r as object), runner: "codex#b", settings: dispatchSettingsHash(strategy, "codex#b") })),
    // cursor: 19 comparable reviews, one short of the threshold
    ...Array.from({ length: 19 }, (_, i) => review("cursor", "mid", { accepted: i % 3 !== 0 })),
    // ignored: too old, excluded repository, at or before the reset, other provenance, kind, difficulty, model or settings
    review("cursor", "mid", { at: oldest - 0.5 }), review("cursor", "mid", { repo: "/repo/excluded" }),
    review("cursor", "mid", { repo: "/repo/reset", at: NOW - 1000 }), review("cursor", "mid", { provenance: "auto" }),
    review("cursor", "mid", { kind: "docs" }), review("cursor", "mid", { difficulty: "complex" }),
    review("cursor", "mid", { model: "other" }), review("cursor", "mid", { settings: "legacy-unknown" }),
    // counted: after the reset, and the requesting agent's own reviews
    review("claude-code", "opus", { repo: "/repo/reset", at: NOW - 999 }),
    ...Array.from({ length: 19 }, () => review("claude-code", "opus", { provenance: "requesting-agent", accepted: false })),
    // kind null reviews for a kind null task
    ...Array.from({ length: 20 }, (_, i) => review("codex", "gpt-x", { kind: null, accepted: i < 15 })),
    // rows that are not reviews
    "{", "5", "\"text\"", "[1]", 7, JSON.stringify({ provenance: "human" }),
  ];

  test("on and off, with and without reviews, at the thresholds and filters", () => {
    const seeded = tmpDir(); seed(seeded, rows);
    const noTables = tmpDir(); mkdirSync(join(noTables, "state"), { recursive: true });
    new Database(join(noTables, "state", "tasks.db")).close();
    const empty = tmpDir();
    const cases: [string, Strategy, string, object, number][] = [
      ["disabled", learningStrategy({ enabled: false, minSamples: 20, maxAgeDays: 90 }), seeded, task, NOW],
      ["no dispatch section", learningStrategy(undefined), seeded, task, NOW],
      ["enabled", strategy, seeded, task, NOW],
      ["kind null", strategy, seeded, { kind: null, difficulty: "standard" }, NOW],
      ["later: the oldest review ages out", strategy, seeded, task, NOW + 0.5],
      ["minSamples 21", learningStrategy({ enabled: true, minSamples: 21, maxAgeDays: 90 }), seeded, task, NOW],
      ["no review tables", strategy, noTables, task, NOW],
      ["no store", strategy, empty, task, NOW],
    ];
    const ts = cases.map(([, s, home, t, now]) => {
      const store = openReadOnlyStore(fakeCtx({ pacerHome: home, now }));
      try {
        const kind = (t as { kind: string | null }).kind, difficulty = (t as { difficulty: string }).difficulty;
        return applyLearnedFit(fakeCtx({ pacerHome: home, now }), s, candidates, kind, difficulty, readOnlyReviewReader(store));
      } finally { store.close(); }
    });
    const fitted = (i: number) => ts[i]!.filter(c => c.learnedFit).map(c => c.runner);
    expect(fitted(0)).toEqual([]);
    expect(fitted(2)).toEqual(["codex", "codex#b", "claude-code"]);
    expect(fitted(3)).toEqual(["codex"]);
    expect(fitted(4)).toEqual(["claude-code"]);
    expect(fitted(5)).toEqual([]);
    expectSame(cases.map(c => c[0]), rust(cases.map(([, s, pacerHome, t, now]) => ({ fn: "learnedFit", strategy: s, pacerHome, candidates, task: t, now }))), ts);

    // Equal learned fit ranks by id; learned fit outranks the configured fit.
    const fit = ts[2]!;
    const ladder = [dispatchConfigSchema.parse({}), dispatchConfigSchema.parse({ steps: [{ id: "learned", rank: ["task-fit"] }] })].map(config => ({
      request: { task: { ...task, requirements: {}, preferences: { models: [], strengths: [] }, provenance: "request" }, candidates: fit } as unknown as DecisionRequest, config,
    }));
    const proposals = ladder.map(c => evaluateLadder(c.request, c.config));
    expectSame(["default steps", "task-fit only"], rust(ladder.map(c => ({ fn: "ladder", ...c }))), proposals);
  });

  test("a null review row fails in both", () => {
    const home = tmpDir(); seed(home, [review("codex", "gpt-x")]);
    const db = new Database(join(home, "state", "tasks.db")); db.run("INSERT INTO work_reviews VALUES ('n',1,1,'human',NULL)"); db.close();
    const store = openReadOnlyStore(fakeCtx({ pacerHome: home }));
    expect(() => applyLearnedFit(fakeCtx({ pacerHome: home, now: NOW }), strategy, candidates, "debug", "standard", readOnlyReviewReader(store))).toThrow(TypeError);
    store.close();
    const [reply] = rust([{ fn: "learnedFit", strategy, pacerHome: home, candidates, task, now: NOW }]);
    expect(JSON.parse(reply!)).toMatchObject({ error: { code: "internal" } });
  });
});

type Deps = NonNullable<Parameters<typeof explainDispatch>[2]>;

/** The Rust request for one explanation: the inputs explainDispatch gathers, gathered the same way. */
async function explainRequest(ctx: Ctx, input: unknown, deps: Deps, kind: RouteExplanation["kind"]): Promise<object> {
  const p = explainInputSchema.parse(input);
  const ro = { ...ctx, readOnly: true };
  const strategy = p.strategyDraft ? draftStrategy(ro, p.strategyDraft) : deps.strategy ?? loadStrategy(ro);
  const requested = p.executor ? resolveRunner(strategy, p.executor)?.id ?? null : null;
  let admissionHooks = false;
  try { admissionHooks = classifierConfig(strategy).configured; } catch { /* no classifier config */ }
  const common = { strategy, kind, requested, pacerHome: ctx.pacerHome, pause: readPause(ro), admissionHooks, draft: !!p.strategyDraft, now: ctx.now };
  const store = openReadOnlyStore(ro);
  try {
    if (p.via === "delegate") {
      const repo = await resolvePolicyRepoInputReadOnly(ro, p.repo);
      const selection = projectSnapshot(ro, strategy, repo.key).selection;
      const status = await deps.status!(ro, strategy);
      const byId = Object.fromEntries(status.providers.map(s => [s.id, s]));
      const ranking = rankExecutors(kind.value, strategy, byId,
        selection && { executors: selection.executors, order: "configured" }, { includePlanner: p.interactionMode === "conversation" });
      if (p.interactionMode === "conversation" && !selection) conversationFallback(ranking, kind.value, strategy, byId, requested);
      const use = slotUse(slotTasksReadOnly(store), ro);
      const guards: { id: string; text: string }[] = [];
      let eligible: typeof ranking.ranked = [];
      for (const candidate of ranking.ranked) {
        const host = strategy.runners[candidate.id]!.host;
        const cached = host ? readHostReachability(ro, strategy.hosts[host]!) : null;
        const unknownHost = host && (!cached || cached.at > ro.now || ro.now - cached.at >= 60);
        const guard = executorExclusion(ro, strategy, candidate.id) ?? slotBlock(strategy, candidate.id, use)
          ?? (unknownHost ? `host ${host} reachability unknown (cached preview)` : await remoteExclusion(ro, strategy, candidate.id,
            { repo: repo.path, placement: "new" }, { reachable: async () => cached?.reachable === true, skipSlots: true }));
        if (guard) guards.push({ id: candidate.id, text: guard });
        else eligible.push(candidate);
      }
      if (strategy.pacing.balance === "least-loaded") eligible = balanceByLoad(eligible, strategy, use, byId);
      return { fn: "explainRanked", ...common, status, input: p, ranking, guards, eligible, selection: selection ?? null };
    }
    const dispatch: ReadOnlyDispatch = { store, exclusions: [], uncertainty: [] };
    const preview = await previewDispatch(ro, {
      repo: p.repo, goal: p.goal.slice(0, 8000), ...(kind.value ? { kind: kind.value } : {}), requirements: p.requirements, preferences: p.preferences,
      ...(p.model ? { model: p.model } : {}), ...(p.delegationEnforcement ? { delegationEnforcement: p.delegationEnforcement } : {}),
    }, { ...deps, strategy, readOnly: dispatch, difficulty: p.difficulty ?? "standard", includePlanner: !!p.allowDelegation });
    return { fn: "explain", ...common, status: dispatch.status, preview, exclusions: dispatch.exclusions, uncertainty: dispatch.uncertainty,
      engineNotRunning: dispatch.engineNotRunning ?? null };
  } finally { store.close(); }
}

/** As `test/dispatch-explain.test.ts`: three executors with the given weekly usage (null: unmeasured). */
function setup(used: Record<string, number | null>, extra: Record<string, unknown> = {}, now = NOW) {
  const ctx = fakeCtx({ now }); mkdirSync(ctx.pacerHome, { recursive: true });
  const strategy = validateStrategy({ planner: "claude-code", accounts: { "claude-code": { kind: "claude" }, codex: { kind: "codex" }, cursor: { kind: "cursor" } },
    runners: { codex: { models: [{ id: "provider/deep", tier: "medium" }] }, cursor: { models: [{ id: "provider/mid", tier: "medium" }] } }, ...extra }, "stratégie 😀");
  const status = async (): Promise<Status> => ({ generatedAt: ctx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
    providers: Object.entries(used).map(([id, pct]) => ({ id, usage: "quota" as const, windows: pct === null ? [] : [{ name: "weekly", usedPct: pct, resetsAt: ctx.now + 3600, lengthS: 604800, paced: true, verdict: "ON_PACE" as const }], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
    accounts: Object.entries(used).map(([id, pct]) => ({ name: id, kind: id === "claude-code" ? "claude" as const : id === "codex" ? "codex" as const : "cursor" as const, verdict: "ON_PACE" as const, usedPct: pct, pacePct: 40.5, resetsAt: ctx.now + 3600, window: "weekly", stale: false, source: null, capturedAt: ctx.now - 30.5, runners: [id], spendUsd: null })),
    executors: { ranked: [], excluded: [] } });
  return { ctx, strategy, deps: { strategy, status } as Deps };
}
const base = () => ({ via: "dispatch" as const, repo: tmpDir(), goal: "Fix the login bug", kind: "debug", delegationEnforcement: "cooperative" as const });
const busy = (ctx: Ctx, executor: string) => {
  const task = createTask(ctx, { brief: { goal: "one", repo: tmpDir() }, kind: "debug", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.executor = executor; });
};
const steps = (...extra: object[]) => {
  const config = dispatchConfigSchema.parse({});
  return dispatchConfigSchema.parse({ steps: [...extra, ...config.steps] });
};

interface Case { label: string; ctx: Ctx; input: Record<string, unknown>; deps: Deps }

async function compare(cases: Case[]): Promise<RouteExplanation[]> {
  const ts: RouteExplanation[] = [], requests: object[] = [];
  for (const c of cases) {
    const explained = await explainDispatch(c.ctx, c.input, c.deps);
    ts.push(explained);
    requests.push(await explainRequest(c.ctx, c.input, c.deps, explained.kind));
  }
  expectSame(cases.map(c => c.label), rust(requests), ts);
  return ts;
}

describe("route explanations", () => {
  test("ladder explanations match TypeScript byte for byte", async () => {
    const cases: Case[] = [];
    const add = (label: string, s: ReturnType<typeof setup>, input: Record<string, unknown>, deps: Deps = s.deps) => cases.push({ label, ctx: s.ctx, input, deps });

    add("select, comfortable", setup({ "claude-code": 10, codex: 20, cursor: 30 }), base());
    add("select, usable at 14.5% free", setup({ "claude-code": 10, codex: 85.5, cursor: 92 }), base());
    add("exactly at the comfortable threshold", setup({ "claude-code": 10, codex: 80, cursor: 85 }), base());
    const reserve = setup({ "claude-code": 10, codex: 75, cursor: 92 });
    reserve.strategy.dispatch = dispatchConfigSchema.parse({ reservePct: 10 });
    add("reserve makes it usable", reserve, base());
    add("override to a later-step executor", setup({ "claude-code": 10, codex: 20, cursor: 85 }), { ...base(), executor: "cursor" });
    // codex's medium model is excluded first, its small model second, for a different reason.
    const twoModels = { runners: { codex: { models: [{ id: "provider/deep", tier: "medium" }, { id: "provider/small", tier: "small" }] },
      cursor: { models: [{ id: "provider/mid", tier: "medium" }] } } };
    add("two exclusions for one runner", setup({ "claude-code": 10, codex: 20, cursor: 30 }, twoModels),
      { ...base(), executor: "codex", model: "provider/mid", requirements: { minTier: "medium" } });
    add("two exclusions, the first refuses", setup({ "claude-code": 10, codex: 100, cursor: 30 }, twoModels),
      { ...base(), executor: "codex", requirements: { minTier: "medium" } });
    add("detected kind", setup({ "claude-code": 10, codex: 20, cursor: 30 }), { ...base(), kind: undefined });
    const skipped = setup({ "claude-code": 10, codex: 95, cursor: 30 });
    skipped.strategy.dispatch = steps({ id: "docs-only", match: { kind: "docs" }, capacity: "comfortable" }, { id: "nobody", candidates: { executors: ["none"] } });
    add("skipped steps and a later-step fallback", skipped, base());
    add("quota exhausted exclusion", setup({ "claude-code": 10, codex: 100, cursor: 30 }), base());
    add("no step matched queues", setup({ "claude-code": 10, codex: 100, cursor: 100 }), base());
    const failing = setup({ "claude-code": 10, codex: 100, cursor: 100 });
    failing.strategy.dispatch = dispatchConfigSchema.parse({ onNoMatch: "fail" });
    add("no step matched fails", failing, base());
    add("override picks an eligible executor", setup({ "claude-code": 10, codex: 20, cursor: 30 }), { ...base(), executor: "cursor" });
    add("override refused: exhausted", setup({ "claude-code": 10, codex: 100, cursor: 30 }), { ...base(), executor: "codex" });
    add("override unavailable: planner", setup({ "claude-code": 10, codex: 20, cursor: 30 }), { ...base(), executor: "claude-code" });
    const blocked = setup({ "claude-code": 10, codex: 20, cursor: 30 }); blockExecutor(blocked.ctx, "codex");
    add("override refused: blocked", blocked, { ...base(), executor: "codex" });
    add("blocked executor listed", blocked, base());
    const full = setup({ "claude-code": 10, codex: 20, cursor: 30 }, { runners: { codex: { max_tasks: 1, models: [{ id: "provider/deep", tier: "medium" }] }, cursor: { models: [{ id: "provider/mid", tier: "medium" }] } } });
    busy(full.ctx, "codex");
    add("override queued: executor busy", full, { ...base(), executor: "codex" });
    add("busy executor listed, tasks readable", full, base());
    const paused = setup({ "claude-code": 10, codex: 20, cursor: 30 }); pause(paused.ctx, { for: "1h" });
    add("paused until a fractional time", paused, base());
    const invalid = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    const bad = { id: "bad-engine", version: "2", decide: async () => ({ state: "nonsense" }) };
    add("engine invalid, queued", invalid, base(), { ...invalid.deps, engine: bad });
    const fallback = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    fallback.strategy.dispatch = dispatchConfigSchema.parse({ engineFallback: "ladder" });
    add("engine invalid, ladder fallback", fallback, base(), { ...fallback.deps, engine: bad });
    const plugin = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    plugin.strategy.dispatch = dispatchConfigSchema.parse({ engine: "plugin:missing-engine" });
    add("plugin engine not running", plugin, base());
    const learning = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    learning.strategy.dispatch = dispatchConfigSchema.parse({ learning: { enabled: true } });
    add("learning without a history store", learning, base());
    const learned = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    learned.strategy.dispatch = dispatchConfigSchema.parse({ learning: { enabled: true } });
    mkdirSync(join(learned.ctx.pacerHome, "state"), { recursive: true });
    const history = new Database(join(learned.ctx.pacerHome, "state", "tasks.db"));
    history.exec("CREATE TABLE work_reviews(task_id TEXT, attempt INTEGER, at REAL, provenance TEXT, data TEXT)");
    for (const [runner, model] of [["codex", "provider/deep"], ["cursor", "provider/mid"]] as const) {
      for (let i = 0; i < 20; i++) {
        history.query("INSERT INTO work_reviews VALUES (?,1,?,'human',?)").run(`${runner}-${i}`, NOW - i, JSON.stringify({ repo: "/r", kind: "debug", difficulty: "standard",
          runner, model, settings: dispatchSettingsHash(learned.strategy, runner), accepted: runner === "cursor" || i % 2 === 0, at: NOW - i, provenance: "human" }));
      }
    }
    history.close();
    add("learning with a review history", learned, base());
    const unknown = setup({ "claude-code": 10, codex: null, cursor: null });
    unknown.strategy.dispatch = dispatchConfigSchema.parse({ steps: [{ id: "any", capacity: "unknown" }] });
    add("unmeasured capacity chosen", unknown, base());
    add("unmeasured capacity, nothing chosen", setup({ "claude-code": 10, codex: null, cursor: null }), base());
    const hooks = setup({ "claude-code": 10, codex: 20, cursor: 30 }, { classifier: { timeout_ms: 5000 } });
    add("admission hooks configured", hooks, base());
    add("strict enforcement", setup({ "claude-code": 10, codex: 20, cursor: 30 }), { ...base(), delegationEnforcement: undefined });
    add("planner may delegate", setup({ "claude-code": 10, codex: 100, cursor: 100 }), { ...base(), allowDelegation: true });

    const reserved = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    const probe = await explainRequest(reserved.ctx, base(), reserved.deps, { value: "debug", source: "given" }) as { preview: { request: { candidates: Candidate[] } } };
    const pools = probe.preview.request.candidates.flatMap(c => c.poolIds);
    expect(pools.length).toBeGreaterThan(0);
    busy(reserved.ctx, "cursor");
    const db = new Database(join(reserved.ctx.pacerHome, "state", "tasks.db"));
    db.exec("CREATE TABLE work_reservations(task_id TEXT PRIMARY KEY, root_id TEXT, runner TEXT, pools TEXT, estimate REAL, at REAL)");
    db.query("INSERT INTO work_reservations VALUES ('r1','r1','x',?,1,1), ('r2','r2','x',?,2,1)").run(JSON.stringify(["elsewhere"]), JSON.stringify([7, pools[0]]));
    db.close();
    add("reserved capacity", reserved, base());

    const draftHome = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    writeFileSync(join(draftHome.ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
    add("strategy draft", draftHome, { ...base(), strategyDraft: { from: "default", set: { dispatch: { onNoMatch: "fail" } } } }, { status: draftHome.deps.status });

    const ts = await compare(cases);
    expect(new Set(ts.map(r => r.outcome))).toEqual(new Set(["select", "queue", "fail", "override"]));
    for (const code of ["step_match", "capacity_comfortable", "capacity_usable", "capacity_unknown", "override", "override_unavailable", "quota_exhausted",
      "blocked_by_user", "executor_busy", "paused", "engine_failed", "no_step_matched", "planner_account", "cached_preview", "capacity_unmeasured",
      "engine_not_running", "learning_unavailable", "reserved_capacity", "admission_hooks"]) {
      expect([code, ts.some(r => JSON.stringify(r).includes(`"code":"${code}"`))]).toEqual([code, true]);
    }
    expect(ts.some(r => r.engine.fallback?.reason === "invalid")).toBe(true);
    expect(ts[cases.findIndex(c => c.label === "learning with a review history")]!.uncertainty.some(u => u.code === "learning_unavailable")).toBe(false);
    expect(ts.some(r => r.fallbacks.some(f => f.state === "eligible" && f.step === "usable-fallback"))).toBe(true);
    expect(ts.some(r => r.step?.skipped.some(s => s.reason === "step_kind_mismatch") && r.step.skipped.some(s => s.reason === "step_no_candidates"))).toBe(true);
    const of = (label: string) => ts[cases.findIndex(c => c.label === label)]!;
    const codes = (label: string) => of(label).reasons.map(r => r.code);
    expect(codes("exactly at the comfortable threshold")).toContain("capacity_comfortable");
    expect(codes("reserve makes it usable")).toContain("capacity_usable");
    const later = of("override to a later-step executor");
    expect([later.outcome, later.chosen?.runner, later.fallbacks.find(f => f.runner === "cursor")?.step]).toEqual(["select", "codex", "usable-fallback"]);
    expect(later.reasons.find(r => r.code === "override_unavailable")?.facts).toEqual({ requested: "cursor", reason: "not_ranked" });
    expect(of("two exclusions for one runner").fallbacks.find(f => f.runner === "codex")?.reason?.code).toBe("pinned_to_other_model");
    expect([of("two exclusions, the first refuses").outcome, codes("two exclusions, the first refuses")]).toEqual(["fail", expect.arrayContaining(["quota_exhausted"])]);
  });

  test("ranked explanations match TypeScript byte for byte", async () => {
    const cases: Case[] = [];
    const delegate = () => ({ ...base(), via: "delegate" as const });
    const add = (label: string, s: ReturnType<typeof setup>, input: Record<string, unknown>) => cases.push({ label, ctx: s.ctx, input, deps: s.deps });
    const ranked = (used: Record<string, number | null>, extra: Record<string, unknown> = {}) => {
      const s = setup(used, extra); delete s.strategy.dispatch; return s;
    };
    add("select", ranked({ "claude-code": 10, codex: 20, cursor: 30 }), delegate());
    add("override hit", ranked({ "claude-code": 10, codex: 20, cursor: 30 }), { ...delegate(), executor: "cursor" });
    add("override unavailable: planner", ranked({ "claude-code": 10, codex: 20, cursor: 30 }), { ...delegate(), executor: "claude-code" });
    add("override with an exhausted window", ranked({ "claude-code": 10, codex: 100, cursor: 30 }), { ...delegate(), executor: "codex" });
    const blocked = ranked({ "claude-code": 10, codex: 20, cursor: 30 }); blockExecutor(blocked.ctx, "codex");
    add("override refused: blocked", blocked, { ...delegate(), executor: "codex" });
    const full = ranked({ "claude-code": 10, codex: 20, cursor: 30 }, { runners: { codex: { max_tasks: 1 } } }); busy(full.ctx, "codex");
    add("override queued: busy", full, { ...delegate(), executor: "codex" });
    add("busy listed, tasks readable", full, delegate());
    const paused = ranked({ "claude-code": 10, codex: 20, cursor: 30 }); pause(paused.ctx, { for: "1h" }); blockExecutor(paused.ctx, "codex");
    add("paused keeps exclusions", paused, delegate());
    add("no executor ranked", ranked({ "claude-code": 10 }), delegate());
    add("ignored inputs", ranked({ "claude-code": 10, codex: 20, cursor: 30 }, { dispatch: {} }), {
      ...delegate(), requirements: { tools: true }, preferences: { models: ["other"] }, model: "other", difficulty: "complex" });
    add("conversation fallback", ranked({ "claude-code": 10, codex: 20 }), { ...delegate(), executor: "claude-code", interactionMode: "conversation" });
    add("admission hooks", ranked({ "claude-code": 10, codex: 20, cursor: 30 }, { classifier: { timeout_ms: 5000 } }), delegate());
    add("unmeasured accounts", ranked({ "claude-code": null, codex: null, cursor: 30 }), delegate());

    const pair = fakeCtx({ now: NOW }); mkdirSync(pair.pacerHome, { recursive: true });
    const strategy = pairStrategy("least-loaded");
    const status = async (): Promise<Status> => ({ generatedAt: pair.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
      providers: Object.keys(strategy.providers).map(id => ({ id, usage: "quota" as const, windows: [], binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
      accounts: [], executors: { ranked: [], excluded: [] } });
    busy(pair, "codex");
    cases.push({ label: "least-loaded balance", ctx: pair, input: delegate(), deps: { strategy, status } });

    const ts = await compare(cases);
    expect(new Set(ts.map(r => r.outcome))).toEqual(new Set(["select", "queue", "fail", "override"]));
    for (const code of ["rank_match", "no_executor_ranked", "override_unavailable", "blocked_by_user", "executor_busy", "paused", "not_configured",
      "ranked_inputs_ignored", "tasks_unavailable", "admission_hooks", "default_model_unresolved", "planner_account"]) {
      expect([code, ts.some(r => JSON.stringify(r).includes(`"code":"${code}"`))]).toEqual([code, true]);
    }
    expect(ts.find(r => r.reasons.some(x => x.code === "paused"))!.fallbacks.some(f => f.state === "excluded")).toBe(true);
    expect(ts.at(-1)!.chosen?.runner).toBe("opencode#tse");
  });

  test("a reservation whose pools are not a list fails in both", async () => {
    const s = setup({ "claude-code": 10, codex: 20, cursor: 30 });
    busy(s.ctx, "cursor");
    const db = new Database(join(s.ctx.pacerHome, "state", "tasks.db"));
    db.exec("CREATE TABLE work_reservations(task_id TEXT PRIMARY KEY, root_id TEXT, runner TEXT, pools TEXT, estimate REAL, at REAL); INSERT INTO work_reservations VALUES ('r','r','x','5',1,1)");
    db.close();
    await expect(explainDispatch(s.ctx, base(), s.deps)).rejects.toBeInstanceOf(TypeError);
    const request = await explainRequest(s.ctx, base(), s.deps, { value: "debug", source: "given" });
    expect(JSON.parse(rust([request])[0]!)).toMatchObject({ error: { code: "internal" } });
  });
});
