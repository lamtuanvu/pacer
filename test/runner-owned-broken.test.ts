import { expect, mock, test } from "bun:test";
import { join } from "node:path";
import { validateStrategy, type ProviderCfg } from "../src/config/strategy";
import type { AttemptOutcome } from "../src/exec/direct";
import type { Status } from "../src/engine/status";
import type { ProviderStatus } from "../src/engine/rank";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { Ctx } from "../src/types";
import { eligibility } from "./fixtures/eligibility";
import { fakeCtx, tmpDir } from "./helpers";

// The owned local route has no runner injection point, so its provider entry is stubbed. Unplanned calls (and other
// test files sharing this process) reach the real implementation.
const real = { ...await import("../src/plugins/executor-production") };
let plan: Record<string, (attempt: number, ctx: Ctx, taskId: string) => AttemptOutcome> | undefined;
const calls: string[] = [];
const owned = (fallback: typeof real.runOwnedDirectCurrent) => async (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, ...rest: unknown[]) => {
  const next = plan?.[cfg.id];
  if (!next) return (fallback as (...a: unknown[]) => Promise<AttemptOutcome>)(ctx, cfg, task, ...rest);
  calls.push(cfg.id);
  const attempt = task.attempts.length + 1, dir = join(ctx.pacerHome, "runs", task.id, String(attempt)), startedAt = 1000 + attempt;
  const out = next(attempt, ctx, task.id);
  // What the bundled provider leaves on the task: the claimed run and its exit receipt.
  updateTask(ctx, task.id, t => {
    t.run = {dir, attempt, executor: cfg.id, startedAt, mode: "current", workdir: task.brief.repo, logFile: out.attempt.log, session: "interactive"};
    t.startIntent = {attempt, providerId: "pacer-exec-direct", dir};
    t.executorExitReceipt = {attempt, providerId: "pacer-exec-direct", dir, startedAt, exitCode: out.exec.code};
  });
  return {...out, attempt: {...out.attempt, startedAt}};
};
mock.module("../src/plugins/executor-production", () => ({
  ...real, runOwnedDirectCurrent: owned(real.runOwnedDirectCurrent), runOwnedDirectNew: owned(real.runOwnedDirectNew),
}));
const { runTask } = await import("../src/tasks/runner");

const strategy = validateStrategy({
  planner: "claude-code", providers: {"claude-code": {}, codex: {}, cursor: {}}, pacing: {policy: "priority"}, execution: {worktree: "current"},
}, "/x");
const status = (): Status => ({generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true,
  providers: Object.keys(strategy.providers).map(id => ({id, eligibility: eligibility(), usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false})) as ProviderStatus[],
  executors: {ranked: [], excluded: []}});
const outcome = (executor: string, code: number, brokenReason?: string): AttemptOutcome => ({
  exec: {code, stdout: `${executor} report`, stderr: "", timedOut: false}, report: `${executor} report`,
  attempt: {executor, model: null, startedAt: 1, endedAt: 2000, exitCode: code, timedOut: false, limitHit: false, log: `/l/${executor}.log`, ...(brokenReason ? {brokenReason} : {})},
});

async function run(p: NonNullable<typeof plan>) {
  plan = p; calls.length = 0;
  const ctx = fakeCtx({run: async () => ({code: 0, stdout: "", stderr: ""})});
  const task = createTask(ctx, {brief: {goal: "g", repo: tmpDir()}, kind: null, requestedExecutor: null, timeoutS: 60});
  try {
    const result = await runTask(ctx, task.id, {loadStrategy: () => strategy, computeStatus: async () => status(),
      verifyRepo: async () => ({files: "a.ts | 2 +-"})});
    return {ctx, result: readTask(ctx, result.id)!};
  } finally { plan = undefined; }
}

test("an owned attempt stopped for a provider retry loop moves to the next executor", async () => {
  const reason = "provider retrying: Provider request failed with HTTP 524";
  const {ctx, result} = await run({codex: () => outcome("codex", 1, reason), cursor: () => outcome("cursor", 0)});
  expect(calls).toEqual(["codex", "cursor"]);
  expect(result.state).toBe("done");
  expect(result.attempts.map(a => a.executor)).toEqual(["codex", "cursor"]);
  expect(result.attempts[0].brokenReason).toBe(reason);
  expect(result.executorProvider).toBe("pacer-exec-direct");
  expect(result.run).toMatchObject({attempt: 2, executor: "cursor"});
  expect(result.executorExitReceipt).toMatchObject({attempt: 2});
  const marks = await Bun.file(join(ctx.pacerHome, "broken.json")).json();
  expect(marks.codex.reason).toBe(reason);
});

test("other owned broken reasons still fail the task", async () => {
  const {result} = await run({codex: () => outcome("codex", 2, "unknown option --foo"), cursor: () => outcome("cursor", 0)});
  expect(calls).toEqual(["codex"]);
  expect(result.state).toBe("failed");
  expect(result.attempts).toHaveLength(1);
  expect(result.result?.report).toEndWith("executor not working: unknown option --foo");
});

/** What the broker records on the current attempt just before it stops a run that made no progress. */
const markUnresponsive = (ctx: Ctx, id: string) =>
  updateTask(ctx, id, t => { t.unresponsive = { attempt: t.attempts.length + 1, pings: 3 }; });

test("an owned attempt stopped for no progress moves to the next executor", async () => {
  const {result} = await run({
    codex: (_attempt, c, id) => { markUnresponsive(c, id); return outcome("codex", 143); },
    cursor: () => outcome("cursor", 0),
  });
  expect(calls).toEqual(["codex", "cursor"]);
  expect(result.state).toBe("done");
  expect(result.attempts.map(a => a.executor)).toEqual(["codex", "cursor"]);
  expect(result.attempts[0].unresponsive).toEqual({ pings: 3 });
  expect(result.attempts[1].unresponsive).toBeUndefined();
  expect(result.unresponsive).toBeUndefined();
});

test("a second unresponsive attempt fails the task", async () => {
  const {result} = await run({
    codex: (_attempt, c, id) => { markUnresponsive(c, id); return outcome("codex", 143); },
    cursor: (_attempt, c, id) => { markUnresponsive(c, id); return outcome("cursor", 143); },
  });
  expect(calls).toEqual(["codex", "cursor"]);
  expect(result.state).toBe("failed");
  expect(result.attempts.map(a => a.executor)).toEqual(["codex", "cursor"]);
  expect(result.attempts.map(a => a.unresponsive?.pings)).toEqual([3, 3]);
  expect(result.result?.report).toEndWith("executor unresponsive: no progress after 3 pings");
});
