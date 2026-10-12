import { expect, test } from "bun:test";
import { activeHooks } from "../src/classify/active";
import { type DecisionHooks, defaultHooks } from "../src/classify/hooks";
import { validateStrategy } from "../src/config/strategy";
import type { ProviderStatus } from "../src/engine/rank";
import type { Status } from "../src/engine/status";
import type { AttemptOutcome } from "../src/exec/direct";
import { type RunnerDeps, runTask } from "../src/tasks/runner";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const s = validateStrategy({
  planner: "claude-code",
  providers: { "claude-code": {}, codex: { usage: "reactive" }, cursor: {} },
  routing: [{ kinds: ["tests"], executors: ["cursor"] }, { default: ["codex", "cursor"] }],
}, "/x");

const status = (): Status => ({
  generatedAt: 0, strategy: "d", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
  executors: { ranked: [], excluded: [] },
  providers: ["codex", "cursor"].map((id) => ({ id, usage: "reactive", windows: [], binding: null, verdict: "OK", installed: true, stale: false })) as ProviderStatus[],
});
const outcome = (executor: string): AttemptOutcome => ({
  exec: { code: 0, stdout: "r", stderr: "", timedOut: false }, report: "r",
  attempt: { executor, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" },
});

function deps(hooks: Partial<DecisionHooks>, picked: string[]): RunnerDeps {
  return {
    loadStrategy: () => s,
    computeStatus: async () => status(),
    runAttempt: async (_c, cfg) => { picked.push(cfg.id); return outcome(cfg.id); },
    verifyRepo: async () => ({ files: "" }),
    hooks: { ...defaultHooks, ...hooks },
  };
}
const newTask = (ctx: ReturnType<typeof fakeCtx>) =>
  createTask(ctx, { brief: { goal: "g", repo: "/r" }, kind: null, requestedExecutor: null, timeoutS: 60 });

test("defaults change nothing and activeHooks starts as defaultHooks", async () => {
  expect(activeHooks).toBe(defaultHooks);
  const ctx = fakeCtx();
  const picked: string[] = [];
  const r = await runTask(ctx, newTask(ctx).id, deps({}, picked));
  expect(picked).toEqual(["codex"]);
  expect(r.result?.check).toBeUndefined();
});

test("taskKind routes by the classified kind; filterExecutors narrows the ranking", async () => {
  const ctx = fakeCtx();
  const a: string[] = [];
  await runTask(ctx, newTask(ctx).id, deps({ taskKind: async () => "tests" }, a));
  expect(a).toEqual(["cursor"]);
  const b: string[] = [];
  await runTask(ctx, newTask(ctx).id, deps({ filterExecutors: async (_c, _t, ranked) => ranked.filter((id) => id !== "codex") }, b));
  expect(b).toEqual(["cursor"]);
});

test("resultCheck is recorded on the result", async () => {
  const ctx = fakeCtx();
  const r = await runTask(ctx, newTask(ctx).id, deps({ resultCheck: async () => ({ pass: false, confidence: 0.8, adapter: "rules" }) }, []));
  expect(r.result?.check).toEqual({ pass: false, confidence: 0.8, adapter: "rules" });
});

test("throwing hooks fall back to defaults", async () => {
  const ctx = fakeCtx();
  const picked: string[] = [];
  const r = await runTask(ctx, newTask(ctx).id, deps({
    taskKind: async () => { throw new Error("kind"); },
    filterExecutors: async () => { throw new Error("filter"); },
    resultCheck: async () => { throw new Error("check"); },
  }, picked));
  expect(picked).toEqual(["codex"]);
  expect(r.result?.status).toBe("done");
  expect(r.result?.check).toBeUndefined();
});

test("the default guard hook has no opinion", async () => {
  expect(await defaultHooks.guard(fakeCtx(), { subagentType: "general-purpose", prompt: "x" })).toBeNull();
});
