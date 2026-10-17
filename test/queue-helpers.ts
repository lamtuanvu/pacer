import { validateStrategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
import type { RunnerDeps } from "../src/tasks/runner";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

export const queueStrategy = (second = false) => validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}, ...(second ? {cursor: {}} : {})}, pacing: {policy: "priority"}}, "test");
export const queueTask = (ctx: ReturnType<typeof fakeCtx>, goal = "work", executor: string | null = null) => createTask(ctx, {brief: {goal, repo: ctx.home}, kind: null, requestedExecutor: executor, timeoutS: 60});
export function queueDeps(s = queueStrategy()): RunnerDeps {
  return {spawnRunner: () => process.pid, loadStrategy: () => s, computeStatus: async () => ({generatedAt: 0, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true, executors: {ranked: [], excluded: []}, providers: Object.keys(s.providers).map(id => ({id, installed: true, verdict: "ON_PACE", windows: [], binding: null, stale: false, usage: "quota"}))} as Status),
    runAttempt: async (_ctx, cfg) => ({exec: {code: 0, stdout: "", stderr: "", timedOut: false}, report: "done", attempt: {executor: cfg.id, model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: ""}}),
    verifyRepo: async () => ({files: ""})};
}
