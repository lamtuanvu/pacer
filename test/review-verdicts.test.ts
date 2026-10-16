import { expect, test } from "bun:test";
import { callOp, OPS } from "../src/api/ops";
import { toApiError } from "../src/api/protocol";
import * as tasks from "../src/core/tasks";
import { buildPrompt } from "../src/exec/prompt";
import { cliDeps, main } from "../src/cli";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { readLabels } from "../src/tasks/labels";
import { fakeCtx } from "./helpers";
import type { DelegateInput } from "../src/tasks/api";

function fixture(state: "done" | "running" | "queued" = "done") {
  const ctx = fakeCtx();
  const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home, feedback: "Keep the existing API" }, kind: "tests", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => {
    t.state = state;
    if (state === "done") t.result = { status: "done", executor: "codex#codex", model: null, files: "", report: "", backend: "direct" };
  });
  const delegate = (c: typeof ctx, input: DelegateInput) => createTask(c, { brief: input.brief, kind: input.kind ?? null, requestedExecutor: input.executor ?? null, timeoutS: 60 });
  return { ctx, task, delegate };
}

test("send back records rejection and retries on the same executor with accumulated feedback", async () => {
  const { ctx, task, delegate } = fixture();
  const result = await tasks.review(ctx, task.id, { verdict: "send_back", note: "name it keepalive_s" }, { delegate });
  expect(result.task).toMatchObject({ id: task.id, review: { accepted: false, note: "name it keepalive_s" }, rev: 4 });
  const child = readTask(ctx, String(result.retry?.id))!;
  expect(child.requestedExecutor).toBe("codex#codex");
  expect(child.brief.feedback).toBe("Keep the existing API\n\nname it keepalive_s");
  expect(buildPrompt(child.brief, child.id)).toContain("## Review feedback\nKeep the existing API\n\nname it keepalive_s");
  expect(child.retryOf).toBe(task.id);
  expect(readLabels(ctx).at(-1)).toMatchObject({ type: "task_review", accepted: false });
});

test("retry verdict records rejection and requests the specified executor", async () => {
  const { ctx, task, delegate } = fixture();
  const result = await tasks.review(ctx, task.id, { verdict: "retry", executor: "cursor#cursor" }, { delegate });
  expect(result.task.review).toMatchObject({ accepted: false });
  expect(result.retry).toMatchObject({ executor: null, rev: 2 });
});

test("legacy accepted works through task.review and returns the reviewed task", async () => {
  const { ctx, task } = fixture();
  expect(await callOp(ctx, "task.review", { id: task.id, accepted: true })).toMatchObject({ task: { id: task.id, rev: 3, review: { accepted: true } } });
});

for (const state of ["running", "queued"] as const) test(`reviewing ${state} conflicts without side effects`, async () => {
  const { ctx, task } = fixture(state);
  expect(await callOp(ctx, "task.review", { id: task.id, verdict: "accept" }).catch(toApiError)).toMatchObject({ code: "conflict" });
  expect(readTask(ctx, task.id)?.review).toBeUndefined();
  expect(readLabels(ctx)).toHaveLength(0);
});

for (const params of [{}, { verdict: "send_back" }, { verdict: "send_back", note: " " }, { verdict: "retry" }, { verdict: "other" }]) test(`invalid review ${JSON.stringify(params)} has no side effects`, async () => {
  const { ctx, task } = fixture();
  expect(await callOp(ctx, "task.review", { id: task.id, ...params }).catch(toApiError)).toMatchObject({ code: "invalid_input" });
  expect(readTask(ctx, task.id)?.review).toBeUndefined();
});

test("review honors expected state and revision for verdicts", async () => {
  const { ctx, task } = fixture();
  for (const params of [{ expect_state: "failed" }, { expect_rev: 1 }]) {
    expect(await callOp(ctx, "task.review", { id: task.id, verdict: "reject", ...params }).catch(toApiError)).toMatchObject({ code: "conflict" });
    expect(readTask(ctx, task.id)?.review).toBeUndefined();
  }
  expect(await callOp(ctx, "task.review", { id: task.id, verdict: "reject", expect_state: "done", expect_rev: 2 })).toMatchObject({ task: { rev: 3, review: { accepted: false } } });
});

test("CLI send back uses core review with note and the runner stub", async () => {
  const { ctx, task } = fixture();
  await Bun.write(`${ctx.pacerHome}/strategy.yaml`, "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const original = cliDeps.spawnRunner, spawned: string[] = [];
  cliDeps.spawnRunner = (_c, id) => { spawned.push(id); return 1; };
  try {
    const r = await main(["review", task.id, "--send-back", "--note", "name it keepalive_s", "--json"], ctx);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    expect(result.task.review).toMatchObject({ accepted: false, note: "name it keepalive_s" });
    expect(spawned).toEqual([result.retry.id]);
    expect(readTask(ctx, result.retry.id)?.brief.feedback).toContain("name it keepalive_s");
  } finally { cliDeps.spawnRunner = original; }
});


test("task.review send back uses the API runner dependency", async () => {
  const { ctx, task } = fixture();
  await Bun.write(`${ctx.pacerHome}/strategy.yaml`, "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const spawned: string[] = [];
  const result = await callOp(ctx, "task.review", { id: task.id, verdict: "send_back", note: "fix it", expect_rev: 2 }, { spawnRunner: (_c, id) => { spawned.push(id); return 1; } }) as any;
  expect(result.task.review.accepted).toBe(false);
  expect(spawned).toEqual([result.retry.id]);
});

test("CLI retry-on passes executor and note to the review", async () => {
  const { ctx, task } = fixture();
  await Bun.write(`${ctx.pacerHome}/strategy.yaml`, "planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {}\n");
  const original = cliDeps.spawnRunner, spawned: string[] = [];
  cliDeps.spawnRunner = (_c, id) => { spawned.push(id); return 1; };
  try {
    const r = await main(["review", task.id, "--retry-on", "cursor#cursor", "--note", "try elsewhere", "--json"], ctx);
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    expect(result.task.review).toMatchObject({ accepted: false, note: "try elsewhere" });
    expect(readTask(ctx, result.retry.id)?.requestedExecutor).toBe("cursor");
    expect(spawned).toEqual([result.retry.id]);
    for (const flags of [["--retry-on"], ["--retry-on", "cursor", "--accept"], ["--send-back"]]) {
      expect((await main(["review", task.id, ...flags], ctx)).code).toBe(2);
    }
  } finally { cliDeps.spawnRunner = original; }
});


test("task.review schema requires a verdict or legacy accepted and verdict-specific fields", () => {
  const schema = OPS["task.review"].params;
  for (const input of [{}, { verdict: "send_back" }, { verdict: "retry" }]) {
    expect(schema.safeParse({ id: "t-x", ...input }).success).toBe(false);
  }
  for (const input of [{ accepted: false }, { verdict: "accept" }, { verdict: "send_back", note: "fix" }, { verdict: "retry", executor: "cursor" }]) {
    expect(schema.safeParse({ id: "t-x", ...input }).success).toBe(true);
  }
});

test("a send back whose retry cannot start records no verdict", async () => {
  const { ctx, task } = fixture();
  const failing = () => { throw new Error("executor unavailable"); };
  await expect(tasks.review(ctx, task.id, { verdict: "send_back", note: "again" }, { delegate: failing })).rejects.toThrow();
  expect(readTask(ctx, task.id)?.review).toBeUndefined();
  expect(readLabels(ctx).filter(l => l.type === "task_review")).toHaveLength(0);
});
