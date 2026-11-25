import { expect, test } from "bun:test";
import { eligibility } from "./fixtures/eligibility";
import { validateStrategy } from "../src/config/strategy";
import { rankExecutors, type ProviderStatus } from "../src/engine/rank";
import { targetTier } from "../src/dispatch/tier-select";
import { tierTargetsSchema } from "../src/dispatch/types";
import type { Verdict } from "../src/types";

// The reported setup: one OpenCode executor with a small and a medium model, and a
// planner (claude-code) that is AHEAD of its weekly pace but declares a frontier model.
const strategy = (pacing: Record<string, unknown> = {}, plannerModels: unknown[] | null = [{ id: "claude-opus", tier: "frontier" }]) => validateStrategy({
  planner: "claude-code",
  accounts: { "claude-code": { kind: "claude" }, gofree: { kind: "endpoint", source: "opencode", provider: "go", usage: "unmetered" } },
  runners: {
    ...(plannerModels ? { "claude-code": { models: plannerModels } } : {}),
    "opencode#gofree": { model: "go/medium", models: [{ id: "go/small", tier: "small" }, { id: "go/medium", tier: "medium" }] },
  },
  routing: [{ default: ["opencode#gofree"] }],
  pacing,
}, "/x");

const st = (id: string, verdict: Verdict, o: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id, usage: id === "claude-code" ? "quota" : "unmetered", windows: [], binding: null, verdict, installed: true, stale: false,
  eligibility: eligibility("eligible"), ...o,
} as ProviderStatus);
const statuses = (planner: Partial<ProviderStatus> = {}) => ({
  "claude-code": st("claude-code", "AHEAD", planner),
  "opencode#gofree": st("opencode#gofree", "UNMETERED"),
});
const complex = targetTier("complex", tierTargetsSchema.parse({}));

test("a complex task ranks the AHEAD planner first when no executor declares a frontier model", () => {
  const s = strategy();
  const r = rankExecutors("feature", s, statuses(), undefined, { targetTier: complex });
  expect(r.ranked.map(e => e.id)).toEqual(["claude-code", "opencode#gofree"]);
  expect(r.ranked[0].tierFallback).toEqual({ targetTier: "frontier", reason: "planner tier fallback: no frontier executor available" });
  expect(r.ranked[0].reason).toBe("planner tier fallback: no frontier executor available");
  expect(r.excluded.map(e => e.id)).not.toContain("claude-code");
});

test("standard and simple tasks keep the planner out when an executor meets the tier", () => {
  for (const difficulty of ["standard", "simple"] as const) {
    const r = rankExecutors("feature", strategy(), statuses(), undefined, { targetTier: targetTier(difficulty, tierTargetsSchema.parse({})) });
    expect(r.ranked.map(e => e.id)).toEqual(["opencode#gofree"]);
    expect(r.ranked[0].tierFallback).toBeUndefined();
  }
});

test("no target tier leaves ranking unchanged", () => {
  expect(rankExecutors("feature", strategy(), statuses()).ranked.map(e => e.id)).toEqual(["opencode#gofree"]);
});

test("pacing.planner_tier_fallback off disables the fallback", () => {
  const s = strategy({ planner_tier_fallback: "off" });
  expect(s.pacing.plannerTierFallback).toBe("off");
  expect(rankExecutors("feature", s, statuses(), undefined, { targetTier: complex }).ranked.map(e => e.id)).toEqual(["opencode#gofree"]);
});

test("an invalid pacing.planner_tier_fallback is rejected", () => {
  expect(() => strategy({ planner_tier_fallback: "maybe" })).toThrow("pacing.planner_tier_fallback must be on or off");
});

test("a planner without a declared tier never qualifies", () => {
  expect(rankExecutors("feature", strategy({}, null), statuses(), undefined, { targetTier: complex }).ranked.map(e => e.id)).toEqual(["opencode#gofree"]);
});

test("hard exclusions still apply to the planner", () => {
  const exhausted = { ...eligibility("ineligible"), budget: "exhausted" as const, reasons: [{ code: "budget_exhausted" as const, evidenceIds: [] }] };
  for (const planner of [{ eligibility: exhausted, verdict: "EXHAUSTED" as Verdict }, { signedOutReason: "Sign in" }, { blockedReason: "manual" }, { installed: false }]) {
    const r = rankExecutors("feature", strategy(), statuses(planner), undefined, { targetTier: complex });
    expect(r.ranked.map(e => e.id)).toEqual(["opencode#gofree"]);
  }
});

test("a project selection gets the planner first with renumbered scores", () => {
  const r = rankExecutors("feature", strategy(), statuses(), { executors: ["opencode#gofree"], order: "configured" }, { targetTier: complex });
  expect(r.ranked.map(e => [e.id, e.score])).toEqual([["claude-code", 2], ["opencode#gofree", 1]]);
});

test("only complex tasks or an explicit min tier get a fallback tier", async () => {
  const { fallbackTier } = await import("../src/dispatch/tier-fallback");
  const targets = tierTargetsSchema.parse({});
  expect(fallbackTier("complex", targets)).toBe("frontier");
  expect(fallbackTier("standard", targets)).toBeUndefined();
  expect(fallbackTier(undefined, targets)).toBeUndefined();
  expect(fallbackTier("standard", targets, "frontier")).toBe("frontier");
});

test("a complex task launches on an uncertain planner over an eligible under-qualified executor", async () => {
  const { fakeCtx } = await import("./helpers");
  const { queueDeps } = await import("./queue-helpers");
  const { createTask, updateTask } = await import("../src/tasks/store");
  const { runTask } = await import("../src/tasks/runner");
  const ctx = fakeCtx(), s = strategy();
  const created = createTask(ctx, { brief: { goal: "large work", repo: ctx.home }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
  const task = updateTask(ctx, created.id, t => { t.difficulty = "complex"; t.difficultySource = "brief"; });
  const deps = queueDeps(s), base = deps.computeStatus!, attempt = deps.runAttempt!;
  const launched: string[] = [];
  deps.computeStatus = async (...args) => {
    const st = await base(...args);
    st.providers = ["claude-code", "opencode#gofree"].map(id => ({ ...st.providers[0], id, eligibility: eligibility(id === "claude-code" ? "uncertain" : "eligible") }));
    return st;
  };
  deps.runAttempt = async (c, cfg, ...rest) => { launched.push(cfg.id); return attempt(c, cfg, ...rest); };
  const result = await runTask(ctx, task.id, deps);
  expect(launched).toEqual(["claude-code"]);
  expect(result.executor).toBe("claude-code");
});

test("drain reserves the busy planner for a queued complex task under least-loaded balance", async () => {
  const { fakeCtx } = await import("./helpers");
  const { queueDeps, queueTask } = await import("./queue-helpers");
  const { readTask, updateTask } = await import("../src/tasks/store");
  const { drainQueue } = await import("../src/tasks/drain");
  const s = validateStrategy({
    planner: "claude-code",
    accounts: { "claude-code": { kind: "claude" }, gofree: { kind: "endpoint", source: "opencode", provider: "go", usage: "unmetered" } },
    runners: {
      "claude-code": { max_tasks: 2, models: [{ id: "claude-opus", tier: "frontier" }] },
      "opencode#gofree": { max_tasks: 2, model: "go/medium", models: [{ id: "go/small", tier: "small" }, { id: "go/medium", tier: "medium" }] },
    },
    routing: [{ default: ["opencode#gofree"] }],
    pacing: { balance: "least-loaded" },
  }, "/x");
  const ctx = fakeCtx(), deps = queueDeps(s), base = deps.computeStatus!;
  deps.computeStatus = async (...args) => {
    const st = await base(...args);
    st.providers = ["claude-code", "opencode#gofree"].map(id => ({ ...st.providers[0], id, verdict: "AHEAD" as Verdict, eligibility: eligibility("eligible") }));
    return st;
  };
  const busy = queueTask(ctx, "busy");
  updateTask(ctx, busy.id, t => { t.state = "running"; t.executor = "claude-code"; t.runnerPid = process.pid; });
  const queued = updateTask(ctx, queueTask({ ...ctx, now: ctx.now - 1 }, "large").id, t => { t.difficulty = "complex"; t.difficultySource = "brief"; t.queue = { reason: "no_slot", since: ctx.now - 1, position: 1 }; });
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([queued.id]);
  expect(readTask(ctx, queued.id)?.executor).toBe("claude-code");
});

const fullPlannerStrategy = () => validateStrategy({
  planner: "claude-code",
  accounts: { "claude-code": { kind: "claude" }, gofree: { kind: "endpoint", source: "opencode", provider: "go", usage: "unmetered" } },
  runners: {
    "claude-code": { max_tasks: 1, models: [{ id: "claude-opus", tier: "frontier" }] },
    "opencode#gofree": { max_tasks: 2, model: "go/medium", models: [{ id: "go/small", tier: "small" }, { id: "go/medium", tier: "medium" }] },
  },
  routing: [{ default: ["opencode#gofree"] }],
}, "/x");

async function fullPlanner() {
  const { fakeCtx } = await import("./helpers");
  const { queueDeps, queueTask } = await import("./queue-helpers");
  const { updateTask } = await import("../src/tasks/store");
  const s = fullPlannerStrategy(), ctx = fakeCtx(), deps = queueDeps(s), base = deps.computeStatus!;
  deps.computeStatus = async (...args) => {
    const st = await base(...args);
    st.providers = ["claude-code", "opencode#gofree"].map(id => ({ ...st.providers[0], id, verdict: "AHEAD" as Verdict, eligibility: eligibility("eligible") }));
    return st;
  };
  const busy = queueTask(ctx, "busy");
  updateTask(ctx, busy.id, t => { t.state = "running"; t.executor = "claude-code"; t.runnerPid = process.pid; });
  return { ctx, deps, queueTask, updateTask };
}

test("a complex task waits for a full planner instead of running below its tier", async () => {
  const { runTask } = await import("../src/tasks/runner");
  const { ctx, deps, queueTask, updateTask } = await fullPlanner();
  const launched: string[] = [], attempt = deps.runAttempt!;
  deps.runAttempt = async (c, cfg, ...rest) => { launched.push(cfg.id); return attempt(c, cfg, ...rest); };
  const task = updateTask(ctx, queueTask(ctx, "large").id, t => { t.difficulty = "complex"; t.difficultySource = "brief"; });
  const result = await runTask(ctx, task.id, deps);
  expect(launched).toEqual([]);
  expect(result.state).toBe("queued");
  expect(result.queue?.reason).toBe("no_slot");
});

test("a standard task still uses the free executor while the planner is full", async () => {
  const { runTask } = await import("../src/tasks/runner");
  const { ctx, deps, queueTask } = await fullPlanner();
  const result = await runTask(ctx, queueTask(ctx, "routine").id, deps);
  expect(result.executor).toBe("opencode#gofree");
});

test("drain keeps a queued complex task waiting for a full planner", async () => {
  const { drainQueue } = await import("../src/tasks/drain");
  const { readTask } = await import("../src/tasks/store");
  const { ctx, deps, queueTask, updateTask } = await fullPlanner();
  const queued = updateTask(ctx, queueTask({ ...ctx, now: ctx.now - 1 }, "large").id, t => { t.difficulty = "complex"; t.difficultySource = "brief"; t.queue = { reason: "no_slot", since: ctx.now - 1, position: 1 }; });
  expect(await drainQueue(ctx, () => process.pid, deps)).toEqual([]);
  expect(readTask(ctx, queued.id)?.state).toBe("queued");
});

test("a planner attempt that hits a limit retries below tier when another task took the planner slot", async () => {
  const { runTask } = await import("../src/tasks/runner");
  const { ctx, deps, queueTask, updateTask } = await fullPlanner();
  // fullPlanner starts with the planner busy; free it so the first attempt runs there.
  for (const t of (await import("../src/tasks/store")).listTasksWhere(ctx, { states: ["running"] })) updateTask(ctx, t.id, r => { r.state = "done"; delete r.runnerPid; });
  const launched: string[] = [], attempt = deps.runAttempt!;
  deps.runAttempt = async (c, cfg, ...rest) => {
    launched.push(cfg.id);
    if (cfg.id !== "claude-code") return attempt(c, cfg, ...rest);
    const other = queueTask(ctx, "other");
    updateTask(ctx, other.id, t => { t.state = "running"; t.executor = "claude-code"; t.runnerPid = process.pid; });
    return { exec: { code: 1, stdout: "rate limit reached", stderr: "", timedOut: false }, report: "rate limit reached", attempt: { executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 1, timedOut: false, limitHit: true, log: "" } };
  };
  const task = updateTask(ctx, queueTask(ctx, "large").id, t => { t.difficulty = "complex"; t.difficultySource = "brief"; });
  const result = await runTask(ctx, task.id, deps);
  expect(launched).toEqual(["claude-code", "opencode#gofree"]);
  expect(result.state).toBe("done");
});
