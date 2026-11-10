import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { defaultHooks } from "../src/classify/hooks";
import type { Status } from "../src/engine/status";
import { launchFor } from "../src/exec/launch";
import { outcome } from "../src/exec/direct";
import { parseDelegateBrief } from "../src/tasks/api";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { createTask } from "../src/tasks/store";
import { eligibility } from "./fixtures/eligibility";
import { fakeCtx } from "./helpers";

const models = [
  { id: "model-small", tier: "small" },
  { id: "model-medium", tier: "medium" },
  { id: "model-frontier", tier: "frontier" },
];
function setup(options: { difficulty?: string; model?: string; models?: typeof models | null; retry?: boolean; targets?: object } = {}) {
  const ctx = fakeCtx();
  const declared = options.models === null ? undefined : options.models ?? models;
  const strategy = validateStrategy({
    planner: "claude-code",
    accounts: { claude: { kind: "claude" }, cursor: { kind: "cursor" }, codex: { kind: "codex" } },
    runners: {
      cursor: { model: declared?.at(-1)?.id ?? "legacy-model", models: declared, session: "headless" },
      ...(options.retry ? { codex: { model: "retry-medium", models: [{ id: "retry-medium", tier: "medium" }], session: "headless" } } : {}),
    },
    pacing: { policy: "priority" },
    routing: [{ default: options.retry ? ["cursor", "codex"] : ["cursor"] }],
    ...(options.targets ? { dispatch: { tierTargets: options.targets } } : {}),
  }, ctx.home);
  const input = parseDelegateBrief({ goal: "g", repo: ctx.home, kind: "tests", difficulty: options.difficulty, model: options.model }, ctx.home);
  const task = createTask(ctx, { ...input, kind: input.kind ?? null, requestedExecutor: null, timeoutS: 60 });
  const argv: string[][] = [];
  const deps: RunnerDeps = {
    loadStrategy: () => strategy,
    computeStatus: async () => ({ generatedAt: ctx.now, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
      providers: Object.keys(strategy.providers).map(id => ({ id, eligibility: eligibility(), usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false })),
      executors: { ranked: [], excluded: [] },
    } as Status),
    hooks: { ...defaultHooks, taskKind: async () => "tests" },
    runAttempt: async (_ctx, cfg) => {
      // Fake the spawn boundary, retaining production argv construction.
      argv.push(launchFor(cfg, "g", ctx.home, ctx.home, task.id).argv);
      const limited = !!options.retry && argv.length === 1;
      const result = outcome(cfg, 1, { code: limited ? 1 : 0, stdout: "report", stderr: "", timedOut: false }, "", "report");
      result.attempt.limitHit = limited;
      return result;
    },
    verifyRepo: async () => ({ files: "(no changes)" }),
  };
  return { argv, ctx, task, deps };
}

test("simple delegate on a tiered runner launches its small model", async () => {
  const { ctx, task, deps, argv } = setup({ difficulty: "simple" });
  const result = await runTask(ctx, task.id, deps);
  expect(result.state).toBe("done");
  expect(argv[0]).toContain("model-small");
  expect(result.attempts[0].tier).toEqual({ requestedDifficulty: "simple", difficultySource: "explicit", effectiveDifficulty: "simple", targetTier: "small", selectedTier: "small", reason: "target-match" });
});

test("complex delegate on a runner with only small models uses the default and records the shortfall", async () => {
  const { ctx, task, deps, argv } = setup({ difficulty: "complex", models: [models[0]] });
  const result = await runTask(ctx, task.id, deps);
  expect(argv[0]).toContain("model-small");
  expect(result.attempts[0].tier).toMatchObject({ targetTier: "frontier", selectedTier: "small", reason: "executor-fixed-below-target" });
});

test("runner without models launches exactly as before", async () => {
  const { ctx, task, deps, argv } = setup({ models: null, difficulty: "complex" });
  const result = await runTask(ctx, task.id, deps);
  expect(argv).toEqual([["cursor-agent", "-p", "--output-format", "text", "--force", "--trust", "--sandbox", "disabled", "--workspace", ctx.home, "--model", "legacy-model", "g"]]);
  expect(result.attempts[0]).not.toHaveProperty("tier");
});

test("model pin launches the pinned model with explicit-override", async () => {
  const { ctx, task, deps, argv } = setup({ difficulty: "simple", model: "model-frontier" });
  const result = await runTask(ctx, task.id, deps);
  expect(argv[0]).toContain("model-frontier");
  expect(result.attempts[0].model).toBe("model-frontier");
  expect(result.attempts[0].tier).toMatchObject({ selectedTier: "frontier", reason: "explicit-override" });
});

test("retry re-selects and records its own tier note", async () => {
  const { ctx, task, deps, argv } = setup({ difficulty: "simple", retry: true });
  const result = await runTask(ctx, task.id, deps);
  expect(result.attempts).toHaveLength(2);
  expect(argv[0]).toContain("model-small");
  expect(argv[1]).toContain("retry-medium");
  expect(result.attempts.map(a => a.tier?.reason)).toEqual(["target-match", "upward-fallback"]);
});

test("unspecified difficulty uses standard and honors configured tier targets", async () => {
  const { ctx, task, deps, argv } = setup({ targets: { simple: "small", standard: "frontier", complex: "frontier" } });
  const result = await runTask(ctx, task.id, deps);
  expect(argv[0]).toContain("model-frontier");
  expect(result.attempts[0].tier).toEqual({ requestedDifficulty: "unspecified", difficultySource: "unspecified", effectiveDifficulty: "standard", targetTier: "frontier", selectedTier: "frontier", reason: "target-match" });
});

test("pin without model declarations records an explicit override", async () => {
  const { ctx, task, deps, argv } = setup({ models: null, model: "legacy-model" });
  const result = await runTask(ctx, task.id, deps);
  expect(argv[0]).toContain("legacy-model");
  expect(result.attempts[0].tier).toMatchObject({ selectedTier: "unknown", reason: "explicit-override" });
});
