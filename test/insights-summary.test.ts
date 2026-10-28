import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { dispatchDatabase } from "../src/dispatch/store";
import { recordAttemptUsage } from "../src/tokens/store";
import { backfillFirstSettled, insightsInputSchema, insightsSummary } from "../src/insights/summary";
import type { Attempt, AttemptTokens } from "../src/tasks/types";

const tok = (coverage: AttemptTokens["coverage"], total: number | null): AttemptTokens => ({
  coverage, input: total, cacheRead: null, cacheWrite: null, output: null, reasoning: null, total, turns: null, source: "executor-json", selfReported: false, extractor: "t@1", capturedAt: 1,
});
const attempt = (executor: string, endedAt: number, tokens: AttemptTokens, skipped: { executor: string; reason: string }[] = []): Attempt =>
  ({ executor, model: null, startedAt: endedAt - 1, endedAt, exitCode: 0, timedOut: false, limitHit: false, log: "", tokens,
    routing: { kind: "feature", kindSource: "brief", rule: "capable", chosen: executor, why: "", skipped } } as Attempt);
const input = (o: Partial<{ from: number; to: number; repo: string; bucket: "day" | "week" }> = {}) => insightsInputSchema.parse({ from: 0, to: 10 * 86400, ...o });

function settle(ctx: ReturnType<typeof fakeCtx>, id: string, at: number, accepted: boolean | null, attempts: Attempt[]) {
  ctx.now = at;
  updateTask(ctx, id, t => { t.state = "done"; t.attempts.push(...attempts); if (accepted !== null) t.review = { accepted, kind: null, note: null, at }; });
  const task = readTask(ctx, id)!;
  task.attempts.forEach((_, i) => recordAttemptUsage(ctx, task, i + 1, task.attempts[i]!.tokens!));
}
const REPO = tmpDir();
const mk = (ctx: ReturnType<typeof fakeCtx>, goal: string, parent?: string) => {
  const t = createTask(ctx, { brief: { goal, repo: REPO }, kind: "feature", requestedExecutor: null, timeoutS: 60 });
  registerWork(ctx, t.id, parent ? {} : { allowDelegation: true }, parent); if (!parent) updateTask(ctx, t.id, x => { x.state = "running"; }); return t;
};

test("root tasks are handled once, at their first settle, and retries do not recount them", () => {
  const ctx = fakeCtx(), root = mk(ctx, "r");
  settle(ctx, root.id, 86400, false, [attempt("codex", 86400, tok("partial", 100))]);
  ctx.now = 3 * 86400; updateTask(ctx, root.id, t => { t.state = "running"; });
  settle(ctx, root.id, 4 * 86400, true, [attempt("claude-code", 4 * 86400, tok("measured", 50))]);
  const early = insightsSummary(ctx, input({ from: 0, to: 2 * 86400 })), later = insightsSummary(ctx, input({ from: 3 * 86400, to: 5 * 86400 }));
  expect([early.rootTasksHandled, later.rootTasksHandled]).toEqual([1, 0]);
  expect(later.tokens.total).toBe(50);
});

test("subtasks, retries, first-try acceptance and the agent spread", () => {
  const ctx = fakeCtx(), clean = mk(ctx, "clean"), messy = mk(ctx, "messy"), child = mk(ctx, "c", messy.id);
  settle(ctx, clean.id, 100, true, [attempt("codex", 100, tok("measured", 200), [{ executor: "cursor", reason: "stale" }])]);
  settle(ctx, child.id, 110, null, [attempt("codex", 110, tok("partial", 60)), attempt("codex", 120, tok("unknown", null))]);
  settle(ctx, messy.id, 130, true, [attempt("claude-code", 130, tok("measured", 40))]);
  const s = insightsSummary(ctx, input());
  expect([s.rootTasksHandled, s.subtasks, s.retryAttempts, s.acceptedFirstTry, s.reviewedRoots]).toEqual([2, 1, 1, 1, 2]);
  expect(s.acceptedFirstTryRate).toBe(0.5);
  expect([s.tokens.total, s.tokens.unknownAttempts, s.tokens.lowerBound]).toEqual([300, 1, true]);
  expect(s.spread.map(g => [g.agent, g.total, g.share])).toEqual([["codex", 260, 260 / 300], ["claude-code", 40, 40 / 300]]);
  expect(s.spread.find(g => g.agent === "codex")!.subtasks).toBe(1);
  expect(s.spread.find(g => g.agent === "claude-code")!.subtasks).toBe(0);
  expect(s.skipReasons).toEqual([{ agent: "cursor", reason: "stale", count: 1 }]);
  expect(s.rules).toEqual([{ rule: "capable", count: 4 }]);
  expect(s.ladder).toEqual([{ step: "1", name: "Capable model with spare capacity", count: 4 }]);
  expect(s.retryTokens).toEqual({ attempts: 1, total: 0, unknownAttempts: 1 });
  expect(s.kindByAgent[0]!.byAgent.codex).toBe(2);
  expect(s.ranOutsidePlanner).toBeNull();
  expect(s.planner.coverage).toBe("unknown");
});

test("repo filter, buckets and an empty period", () => {
  const ctx = fakeCtx(), a = mk(ctx, "a");
  settle(ctx, a.id, 2 * 86400, true, [attempt("codex", 2 * 86400, tok("measured", 10))]);
  expect(insightsSummary(ctx, input({ repo: "no-such-repo" })).rootTasksHandled).toBe(0);
  expect(insightsSummary(ctx, input({ bucket: "week" })).daily).toHaveLength(1);
  const empty = insightsSummary(ctx, input({ from: 50 * 86400, to: 60 * 86400 }));
  expect([empty.rootTasksHandled, empty.tokens.total, empty.spread, empty.acceptedFirstTryRate]).toEqual([0, 0, [], null]);
  expect(empty.previous.rootTasksHandled).toBe(0);
});

test("backfill adds first-settle rows only, estimating retried tasks from the first attempt", () => {
  const ctx = fakeCtx(), once = mk(ctx, "once"), twice = mk(ctx, "twice");
  settle(ctx, once.id, 500, true, [attempt("codex", 400, tok("measured", 1))]);
  settle(ctx, twice.id, 900, true, [attempt("codex", 300, tok("measured", 1)), attempt("codex", 800, tok("measured", 1))]);
  dispatchDatabase(ctx).query("DELETE FROM task_first_settle").run();
  expect(backfillFirstSettled(ctx)).toBe(2);
  const at = (id: string) => dispatchDatabase(ctx).query<{ at: number }, [string]>("SELECT at FROM task_first_settle WHERE task_id=?").get(id)!.at;
  expect([at(once.id), at(twice.id)]).toEqual([500, 300]);
  expect(backfillFirstSettled(ctx)).toBe(0);
});

test("input is validated", () => {
  expect(insightsInputSchema.safeParse({ from: 5, to: 5 }).success).toBe(false);
  expect(insightsInputSchema.safeParse({ from: 0, to: 999 * 86400 }).success).toBe(false);
  expect(insightsInputSchema.safeParse({ from: 0, to: 10, bucket: "year" }).success).toBe(false);
});
