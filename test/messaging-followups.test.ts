// test/messaging-followups.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import * as core from "../src/core";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import * as store from "../src/messaging/store";
import { readOutboxSince } from "../src/link/store";

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

const settle = (ctx: ReturnType<typeof asked>["ctx"], id: string, state: "done" | "needs_input") => updateTask(ctx, id, x => {
  x.state = state; x.attempts = [{ executor: "codex", model: null, startedAt: 1, endedAt: 2, exitCode: 0, timedOut: false, limitHit: false, log: "" }];
  x.result = { status: state, executor: "codex", model: null, files: "", report: "r", backend: "direct" };
  if (state === "needs_input") x.question = { text: "Which table?", at: 1 };
});
const capAt = (ctx: ReturnType<typeof asked>["ctx"], id: string) => {
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nmessaging:\n  tree: {max_turns: 1}\n");
  store.recordTurn(ctx, { id: `${id}#1`, taskId: id, rootId: `task:${id}`, at: 1 });
};
const messageEvents = async (ctx: ReturnType<typeof asked>["ctx"]) => {
  await new Promise(r => setTimeout(r, 50));
  return readOutboxSince(ctx, 0).filter(e => e.envelope.type === "entity" && (e.envelope.data as { kind: string }).kind === "message");
};

test("answer on the message path keeps the needs_input and revision checks", async () => {
  const { ctx, id } = asked();
  const spawn = { spawnRunner: () => 1 };
  await expect(callOp(ctx, "task.answer", { id, text: "users" }, spawn)).rejects.toMatchObject({ code: "conflict" }); // running, no question
  const t = settle(ctx, id, "needs_input");
  await expect(callOp(ctx, "task.answer", { id, text: "users", expect_rev: t.rev - 1 }, spawn)).rejects.toMatchObject({ code: "conflict" });
  expect(store.thread(ctx, id)).toEqual([]);
});

test("answer uses a deterministic request id, publishes the message and attributes the app user", async () => {
  const { ctx, id } = asked();
  const t = settle(ctx, id, "needs_input");
  const r = await callOp(ctx, "task.answer", { id, text: "users", expect_rev: t.rev }, { spawnRunner: () => 1, appAuthenticated: true }) as any;
  expect(r.retry.id).toBe(id);
  const [m] = store.thread(ctx, id).filter(x => x.kind === "answer");
  expect(m).toMatchObject({ from: "human", requestId: `answer:${id}:${t.rev}` });
  expect((await messageEvents(ctx)).map(e => (e.envelope.data as { id: string }).id)).toContain(m!.id);
});

test("answer falls back to a legacy retry when no turn can start", async () => {
  const { ctx: base, id } = asked();
  const ctx = { ...base, run: realRun };
  updateTask(ctx, id, x => { x.worktree = gitRepo(); });
  settle(ctx, id, "needs_input");
  capAt(ctx, id);
  const spawned: string[] = [];
  const r = await callOp(ctx, "task.answer", { id, text: "users" }, { spawnRunner: (_c, tid) => { spawned.push(tid); return 1; } }) as any;
  expect(r.retry.id).not.toBe(id);
  expect(readTask(ctx, r.retry.id)!.brief.qa).toEqual([{ q: "Which table?", a: "users" }]);
  expect(readTask(ctx, id)!.question?.answer).toBe("users");
  expect(store.pendingFor(ctx, `task:${id}`)).toEqual([]);
  expect(spawned).toEqual([r.retry.id]);
});

test("send_back on the message path checks the revision and uses a deterministic request id", async () => {
  const { ctx, id } = asked();
  const t = settle(ctx, id, "done");
  await expect(callOp(ctx, "task.review", { id, verdict: "send_back", note: "add tests", expect_rev: t.rev - 1 }, { spawnRunner: () => 1 })).rejects.toMatchObject({ code: "conflict" });
  expect(store.thread(ctx, id)).toEqual([]);
  const r = await callOp(ctx, "task.review", { id, verdict: "send_back", note: "add tests", expect_rev: t.rev }, { spawnRunner: () => 1, appAuthenticated: true }) as any;
  expect(r.retry.id).toBe(id);
  const [m] = store.thread(ctx, id);
  expect(m).toMatchObject({ from: "human", requestId: `sendback:${id}:${t.rev}`, body: "Review feedback: add tests" });
  expect((await messageEvents(ctx)).map(e => (e.envelope.data as { id: string }).id)).toContain(m!.id);
});

test("send_back falls back to a legacy retry with a recorded verdict when no turn can start", async () => {
  const { ctx, id } = asked();
  settle(ctx, id, "done");
  capAt(ctx, id);
  const r = await callOp(ctx, "task.review", { id, verdict: "send_back", note: "add tests" }, { spawnRunner: () => 1 }) as any;
  expect(r.retry.id).not.toBe(id);
  expect(readTask(ctx, r.retry.id)!.brief.feedback).toContain("add tests");
  expect(readTask(ctx, id)!.review).toBeDefined();
  expect(store.pendingFor(ctx, `task:${id}`)).toEqual([]);
});
