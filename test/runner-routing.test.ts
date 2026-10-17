import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { defaultHooks } from "../src/classify/hooks";
import type { Status } from "../src/engine/status";
import { ruleFor } from "../src/engine/rank";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const strategy = validateStrategy({
  planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} },
  pacing: { policy: "priority" },
  routing: [{ kinds: ["tests", "refactor"], executors: ["codex", "cursor"] }, { default: ["cursor"] }],
}, "/x");
function setup(kind: string | null = "tests") {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home, acceptance: "true" }, kind, requestedExecutor: null, timeoutS: 60 });
  let reads = 0;
  const deps: RunnerDeps = {
    loadStrategy: () => strategy,
    computeStatus: async () => ({
      generatedAt: ctx.now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
      accounts: [{ name: strategy.runners.cursor.account, kind: "cursor", verdict: "ON_PACE", pacePct: null, resetsAt: null, stale: false, source: null, capturedAt: null, runners: ["cursor"], usedPct: ++reads === 1 ? 3 : 4.2, window: "week" }],
      providers: Object.keys(strategy.providers).map(id => ({ id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false, ...(id === "codex" ? { blockedReason: "manual" } : {}) })),
      executors: { ranked: [], excluded: [] },
    } as Status),
    hooks: { ...defaultHooks, taskKind: async () => "tests" },
    runAttempt: async () => ({ exec: { code: 0, stdout: "", stderr: "", timedOut: false }, report: "report", attempt: { executor: "cursor", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" } }),
    verifyRepo: async () => ({ files: "(no changes)" }),
  };
  return { ctx, task, deps };
}

test("records the matching rule, choice, exclusions and account readings", async () => {
  const { ctx, task, deps } = setup();
  const result = await runTask(ctx, task.id, deps);
  expect(result.state).toBe("done");
  expect(result.attempts[0].routing).toEqual({ kind: "tests", kindSource: "brief", rule: "tests, refactor", chosen: "cursor", why: "on pace", skipped: [{ executor: "codex", reason: "Blocked by you" }] });
  expect(result.attempts[0].usageAtStart).toMatchObject({ account: strategy.runners.cursor.account, usedPct: 3, window: "week", at: expect.any(Number) });
  expect(result.attempts[0].usageAtEnd).toMatchObject({ account: strategy.runners.cursor.account, usedPct: 4.2, window: "week" });
});
test("records classifier as the source when no kind was supplied", async () => {
  const { ctx, task, deps } = setup(null);
  expect((await runTask(ctx, task.id, deps)).attempts[0].routing?.kindSource).toBe("classifier");
});
test("ruleFor preserves routing fallback and index", () => {
  expect(ruleFor("tests", strategy)).toEqual({ index: 0, kinds: ["tests", "refactor"] });
  expect(ruleFor(null, strategy)).toEqual({ index: 1, kinds: null });
});
test("the testing phase is persisted before verification", async () => {
  const { ctx, task, deps } = setup();
  let phase: string | undefined;
  deps.verifyRepo = async () => { phase = readTask(ctx, task.id)?.progress?.phase; return { files: "" }; };
  await runTask(ctx, task.id, deps);
  expect(phase).toBe("testing");
});
test("persists the routing decision and starting usage before launching", async () => {
  const { ctx, task, deps } = setup();
  const run = deps.runAttempt!;
  let checkpoint: unknown;
  deps.runAttempt = async (...args) => { checkpoint = readTask(ctx, task.id)?.pendingAttempt; return run(...args); };
  const result = await runTask(ctx, task.id, deps);
  expect(checkpoint).toMatchObject({ routing: { chosen: "cursor" }, usageAtStart: { usedPct: 3 } });
  expect(result.pendingAttempt).toBeUndefined();
});
test("an unavailable end reading does not lose the attempt", async () => {
  const { ctx, task, deps } = setup();
  const status = deps.computeStatus;
  let calls = 0;
  deps.computeStatus = async (...args) => { if (++calls === 2) throw Error("usage unavailable"); return status(...args); };
  const result = await runTask(ctx, task.id, deps);
  expect(result.state).toBe("done");
  expect(result.attempts[0].usageAtEnd).toMatchObject({ account: strategy.runners.cursor.account, usedPct: null, window: null });
});
