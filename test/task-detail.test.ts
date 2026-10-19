import { withLoginIndicators } from "./helpers";
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import { appendActivity } from "../src/activity/log";
import { createTask, updateTask } from "../src/tasks/store";
import type { Attempt } from "../src/tasks/types";
import { fakeCtx, gitRepo, realRun } from "./helpers";

async function fixture() {
  const repo = gitRepo(), ctx = withLoginIndicators(fakeCtx({ run: realRun }));
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), 'planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n  cursor: {}\nrouting:\n  - kinds: [tests]\n    executors: [codex, cursor]\n');
  const task = createTask(ctx, { brief: { goal: "Add tests", repo, acceptance: "bun test" }, kind: "tests", requestedExecutor: null, timeoutS: 60 });
  const attempt: Attempt = { executor: "codex", model: null, startedAt: ctx.now - 20, endedAt: ctx.now - 10, exitCode: 0, timedOut: false, limitHit: false, log: "executor output", routing: { kind: "tests", kindSource: "brief", rule: "tests", chosen: "codex", why: "on pace", skipped: [] }, usageAtStart: { account: "team", usedPct: 3, window: "week", at: ctx.now - 20 }, usageAtEnd: { account: "team", usedPct: 4.2, window: "week", at: ctx.now - 10 } };
  updateTask(ctx, task.id, t => { t.state = "done"; t.attempts = [attempt]; t.baseBranch = "main"; t.worktree = repo; t.result = { status: "done", executor: "codex", model: null, files: "", report: "Added tests", backend: "direct", acceptance: { cmd: "bun test", passed: true, tail: "38 passed", summary: "38 passed", durationS: 1 } }; });
  writeFileSync(join(repo, "added.txt"), "hello\n");
  await realRun(["git", "-C", repo, "add", "."], 10000);
  return { ctx, task, attempt };
}

test("task.get returns complete task detail, diffstat and ordered timeline", async () => {
  const { ctx, task, attempt } = await fixture();
  appendActivity({ ...ctx, now: ctx.now - 5 }, { kind: "verdict", level: "info", taskId: task.id, text: "Accepted" });
  const detail = await callOp(ctx, "task.get", { id: task.id }) as any;
  expect(detail).toMatchObject({ id: task.id, rev: 2, brief: { goal: "Add tests" }, routing: { chosen: "codex" }, startedAt: attempt.startedAt, endedAt: attempt.endedAt, summary: "Added tests", base: "main", machine: null, acceptance: { state: "passed", summary: "38 passed" }, attempts: [{ log: "executor output" }] });
  expect(detail.files).toMatchObject([{ path: "added.txt", status: "added" }]);
  expect(detail.timeline[0].text).toStartWith("Routed to Codex");
  expect(detail.timeline.at(-1).text).toBe("Accepted");
  expect(detail.cost.executor).toMatchObject({ deltaPct: 1.2, account: "team" });
});

test("cost suppresses shared account usage, including active attempts", async () => {
  const { ctx, task, attempt } = await fixture();
  const other = createTask(ctx, { brief: task.brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, other.id, t => { t.state = "running"; t.attemptStartedAt = attempt.startedAt + 1; t.pendingAttempt = { usageAtStart: attempt.usageAtStart }; });
  expect((await callOp(ctx, "task.get", { id: task.id }) as any).cost.executor).toMatchObject({ deltaPct: null, reason: "shared" });
});

test("retry options use the kind chain and omit the executor that ran", async () => {
  const { ctx, task } = await fixture();
  const busy = createTask(ctx, { brief: task.brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, busy.id, t => { t.state = "running"; t.executor = "cursor"; });
  const options = await callOp(ctx, "task.retry_options", { id: task.id }) as any[];
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({ id: "cursor", reason: "busy" });
});

test("missing readings have an explicit reason and unknown ids are rejected", async () => {
  const { ctx, task } = await fixture();
  updateTask(ctx, task.id, t => { delete t.attempts[0].usageAtEnd; });
  expect((await callOp(ctx, "task.get", { id: task.id }) as any).cost.executor).toMatchObject({ deltaPct: null, reason: "no_reading" });
  expect(await callOp(ctx, "task.retry_options", { id: "missing" }).catch(toApiError)).toMatchObject({ code: "unknown_task" });
});

test("an in-flight fallback uses its own usage reading rather than the preceding attempt", async () => {
  const { ctx, task } = await fixture();
  updateTask(ctx, task.id, t => {
    t.state = "running"; delete t.result;
    t.attemptStartedAt = ctx.now - 5;
    t.pendingAttempt = { usageAtStart: { account: "fallback", usedPct: 12, window: "week", at: ctx.now - 5 } };
  });
  expect((await callOp(ctx, "task.get", { id: task.id }) as any).cost.executor).toMatchObject({ account: "fallback", deltaPct: null, reason: "no_reading" });
});

test("the settle entry follows testing even when the executor ended before acceptance", async () => {
  const { ctx, task } = await fixture();
  updateTask(ctx, task.id, t => {
    t.progress = { phase: "testing", lastOutputAt: null, lastChangeAt: null, files: 1, commits: 2, logBytes: 10, host: "local", updatedAt: ctx.now - 9 };
  });
  const detail = await callOp(ctx, "task.get", { id: task.id }) as any;
  expect(detail.timeline.at(-1).text).toBe("done");
});

test("overlapping settled attempts share cost but disjoint attempts do not", async () => {
  const { ctx, task, attempt } = await fixture();
  const other = createTask(ctx, { brief: task.brief, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, other.id, t => { t.state = "done"; t.attempts = [{ ...attempt, startedAt: attempt.startedAt + 1 }]; });
  expect((await callOp(ctx, "task.get", { id: task.id }) as any).cost.executor).toMatchObject({ deltaPct: null, reason: "shared" });
  updateTask(ctx, other.id, t => { t.attempts[0].startedAt = attempt.endedAt; t.attempts[0].endedAt = ctx.now; });
  expect((await callOp(ctx, "task.get", { id: task.id }) as any).cost.executor).toMatchObject({ deltaPct: 1.2 });
});
