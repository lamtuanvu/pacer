// test/messaging-followups.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import * as core from "../src/core";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import * as store from "../src/messaging/store";

function asked() {
  const ctx = fakeCtx({ env: { CLAUDECODE: "1" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  updateTask(ctx, t.id, x => {
    x.origin = "external:claude-code"; x.state = "running"; x.worktree = tmpDir();
    x.run = { dir: tmpDir(), attempt: 1, executor: "codex", startedAt: 1, mode: "new", workdir: x.worktree, logFile: "/dev/null", agentSession: { id: "sid-1", source: "header" } };
  });
  return { ctx, id: t.id };
}

test("ask records a question message; answer resumes the same task", async () => {
  const { ctx, id } = asked();
  await core.tasks.ask({ ...ctx, env: { PACER_ROLE: "executor", PACER_TASK_ID: id } }, id, "Which table?");
  expect(store.inbox(ctx, "external:claude-code").map(m => [m.kind, m.body])).toEqual([["question", "Which table?"]]);
  updateTask(ctx, id, x => { x.state = "needs_input"; x.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    x.result = { status: "needs_input", executor: "codex", model: null, files: "", report: "", backend: "direct" }; });
  const spawned: string[] = [];
  const r = await callOp(ctx, "task.answer", { id, text: "users" }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } }) as any;
  expect(r.retry.id).toBe(id);
  expect(spawned).toEqual([id]);
  expect(readTask(ctx, id)!.question?.answer).toBe("users");
  expect(store.pendingFor(ctx, `task:${id}`).map(m => m.kind)).toEqual(["answer"]);
});

test("send_back continues the same session without recording a verdict", async () => {
  const { ctx, id } = asked();
  updateTask(ctx, id, x => { x.state = "done"; x.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
    x.result = { status: "done", executor: "codex", model: null, files: "", report: "r", backend: "direct" }; });
  const r = await callOp(ctx, "task.review", { id, verdict: "send_back", note: "add tests" }, { spawnRunner: () => 1 }) as any;
  expect(r.retry.id).toBe(id);
  expect(readTask(ctx, id)!.review).toBeUndefined();
  expect(readTask(ctx, id)!.state).toBe("queued");
});
