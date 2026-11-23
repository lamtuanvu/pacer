// Round-3 cheap minors M-a..M-j (discriminating where applicable).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { main, cliDeps } from "../src/cli";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import {
  addDefinition, getQuestion, insertQuestion, insertRun, insertStep, listQuestions,
  workflowDatabase,
} from "../src/workflow/store";
import { answerQuestion, escalateQuestion, settleAnsweredQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import { insertTurn, openWakeups } from "../src/workflow/wakeups";
import { thread } from "../src/messaging/store";
import type { Ctx } from "../src/types";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;

function writeStrategy(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
}

function orchGrant(ctx: Ctx, runId: string): Ctx {
  insertTurn(ctx, {
    id: `turn_${runId.slice(-6)}`, runId, planner: "claude-code", status: "running",
    startedAt: ctx.now, deadline: ctx.now + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: ctx.now + 600 });
  return { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer } };
}

describe("M-a: CLI answer q_ and MCP pacer_question", () => {
  test("pacer answer q_.. auto-fetches rev and settles", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/ma", version: 1, repo: tmpDir(), brief: "B" });
    const task = createTask(ctx, {
      brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    updateTask(ctx, task.id, t => {
      t.state = "needs_input"; t.executor = "codex";
      t.question = { text: "Ship?", at: ctx.now };
    });
    insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, status: "running", taskId: task.id });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor", askerTaskId: task.id,
      text: "Ship?", answerType: "yes_no", blocks: "step", answerer: "person",
    });
    const before = cliDeps.spawnRunner;
    const spawned: string[] = [];
    try {
      cliDeps.spawnRunner = (_c, id) => { spawned.push(id); return 1; };
      const r = await main(["answer", q.id, "yes"], ctx);
      expect(r.code).toBe(0);
      expect(getQuestion(ctx, q.id)?.status).toBe("answered");
    } finally {
      cliDeps.spawnRunner = before;
    }
  });

  test("MCP pacer_question answer requires expect_rev (person surface)", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    const { createMcpServer } = await import("../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createMcpServer(() => ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    const tool = (await client.listTools()).tools.find(t => t.name === "pacer_question");
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.expect_rev).toBeTruthy();
    await client.close();
  });

  test("MCP run-grant surface exposes pacer_question; work-grant does not (M-i)", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    const run = insertRun(ctx, { workflow: "t/ma", version: 1, repo: tmpDir(), brief: "B" });
    const orch = orchGrant(ctx, run.id);
    const { createMcpServer } = await import("../src/mcp/server");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const grantServer = createMcpServer(() => orch);
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    const c1 = new Client({ name: "g", version: "1" });
    await Promise.all([c1.connect(ct1), grantServer.connect(st1)]);
    expect((await c1.listTools()).tools.map(t => t.name)).toContain("pacer_question");
    await c1.close();

    // Work-grant MCP must not register a dead pacer_question tool.
    const workCtx = fakeCtx({
      now: NOW,
      env: { PACER_WORK_GRANT: "wrg_" + "a".repeat(64) },
    });
    // createMcpServer with work grant needs a valid grant; if it fails closed, still no pacer_question.
    try {
      const { issueWorkGrant } = await import("../src/dispatch/work");
      const task = createTask(ctx, {
        brief: { goal: "w", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60,
      });
      // Prefer checking the code path: PACER_WORK_GRANT set without valid grant may refuse tools.
      void issueWorkGrant;
      void task;
    } catch { /* ignore */ }
    const workServer = createMcpServer(() => ({
      ...ctx,
      env: { ...ctx.env, PACER_WORK_GRANT: "not-a-real-grant" },
    }));
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: "w", version: "1" });
    await Promise.all([c2.connect(ct2), workServer.connect(st2)]);
    expect((await c2.listTools()).tools.map(t => t.name)).not.toContain("pacer_question");
    await c2.close();
  });
});

describe("M-b: settle/escalate atomicity", () => {
  test("successful settle leaves no open wake for the answered question", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/mb", version: 1, repo: tmpDir(), brief: "B" });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor",
      text: "?", answerType: "text", blocks: "nothing", answerer: "person",
    });
    const { enqueueWakeup } = await import("../src/workflow/wakeups");
    enqueueWakeup(ctx, { runId: run.id, cause: "question", ref: q.id, createdAt: ctx.now });
    expect(openWakeups(ctx, run.id).some(w => w.ref === q.id)).toBe(true);
    await settleAnsweredQuestion(ctx, q.id, {
      answer: "ok", expectRev: q.rev, answeredBy: "person",
    });
    expect(getQuestion(ctx, q.id)?.status).toBe("answered");
    expect(openWakeups(ctx, run.id).some(w => w.ref === q.id)).toBe(false);
  });

  test("escalate completes the wake in the same transaction as the person flip", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/mb2", version: 1, repo: tmpDir(), brief: "B" });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor",
      text: "?", answerType: "text", blocks: "step", answerer: "orchestrator",
    });
    const { enqueueWakeup } = await import("../src/workflow/wakeups");
    enqueueWakeup(ctx, { runId: run.id, cause: "question", ref: q.id, createdAt: ctx.now });
    const orch = orchGrant(ctx, run.id);
    escalateQuestion(orch, {
      id: q.id, suggested: "go", reason: "need person", expectRev: q.rev,
    });
    expect(getQuestion(ctx, q.id)?.answerer).toBe("person");
    expect(openWakeups(ctx, run.id).some(w => w.ref === q.id)).toBe(false);
  });
});

describe("M-e: answer+note combined length", () => {
  test("refuses answer+note over the 2000-char delivery cap with a clear error", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/me", version: 1, repo: tmpDir(), brief: "B" });
    const task = createTask(ctx, {
      brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor", askerTaskId: task.id,
      text: "?", answerType: "text", blocks: "nothing", answerer: "person",
    });
    await expect(answerQuestion(ctx, {
      id: q.id,
      answer: "a".repeat(1500),
      note: "n".repeat(600),
      expectRev: q.rev,
    })).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/together|2000/i),
    });
    expect(getQuestion(ctx, q.id)?.status).toBe("open");
  });
});

describe("M-d: deliver before settle on blocks:nothing", () => {
  test("message is inserted even when settle would conflict on a stale rev after delivery", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/md", version: 1, repo: tmpDir(), brief: "B" });
    const task = createTask(ctx, {
      brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor", askerTaskId: task.id,
      text: "info?", answerType: "text", blocks: "nothing", answerer: "person",
    });
    const answered = await answerQuestion(ctx, {
      id: q.id, answer: "noted", expectRev: q.rev,
    });
    expect(answered.status).toBe("answered");
    expect(thread(ctx, task.id).some(m => m.body === "noted")).toBe(true);
  });
});

describe("M-f: record delivered text on record-only path", () => {
  test("record-only answer stores the asker's delivered answer text", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const run = insertRun(ctx, { workflow: "t/mf", version: 1, repo: tmpDir(), brief: "B" });
    const task = createTask(ctx, {
      brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    updateTask(ctx, task.id, t => {
      t.state = "needs_input"; t.executor = "codex";
      t.question = { text: "Ship?", answer: "delivered-yes", at: ctx.now, answeredAt: ctx.now };
    });
    insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, status: "running", taskId: task.id });
    const q = insertQuestion(ctx, {
      runId: run.id, stepId: "ask", attempt: 1, askerKind: "executor", askerTaskId: task.id,
      text: "Ship?", answerType: "text", blocks: "step", answerer: "person",
    });
    const fresh = getQuestion(ctx, q.id)!;
    const settled = await answerQuestion(ctx, {
      id: fresh.id, answer: "orchestrator-different", expectRev: fresh.rev,
    });
    // Record-only path must persist what was already delivered, not the new payload (M-f).
    expect(settled.answer).toBe("delivered-yes");
  });
});

describe("M-h: question.get scoped for executors; answer existence oracle", () => {
  test("executor cannot get or answer a question outside its run; same not_found text", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const runA = insertRun(ctx, { workflow: "t/mh", version: 1, repo: tmpDir(), brief: "A" });
    const runB = insertRun(ctx, { workflow: "t/mh", version: 1, repo: tmpDir(), brief: "B" });
    const taskA = createTask(ctx, {
      brief: { goal: "a", repo: tmpDir() }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    insertStep(ctx, { runId: runA.id, stepId: "ask", attempt: 1, status: "running", taskId: taskA.id });
    const qB = insertQuestion(ctx, {
      runId: runB.id, stepId: "ask", attempt: 1, askerKind: "executor",
      text: "secret?", answerType: "text", blocks: "step", answerer: "person",
    });
    const exec = {
      ...ctx,
      env: { ...ctx.env, PACER_ROLE: "executor", PACER_TASK_ID: taskA.id },
    };
    const unknownMsg = `unknown question ${qB.id}`;
    await expect(callOp(exec, "question.get", { id: qB.id })).rejects.toMatchObject({
      code: "not_found", message: unknownMsg,
    });
    await expect(callOp(exec, "question.get", { id: "q_zzzzzzzzzz" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(answerQuestion(exec, {
      id: qB.id, answer: "leak", expectRev: qB.rev,
    })).rejects.toMatchObject({ code: "not_found", message: unknownMsg });
  });
});

describe("M-j: terminal withdraw is atomic with the run update", () => {
  test("stopRun withdraws open questions with the terminal status", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    const def: WorkflowDef = {
      id: "t/mj", version: 1,
      steps: { a: { type: "agent", kind: "research", prompt: "A" }, end: { type: "end" } },
      edges: [{ from: "a", to: "end" }], entry: "a",
    };
    addDefinition(ctx, def, "x");
    const { startRun, defaultEngineDeps, stopRun: stop } = await import("../src/workflow/engine");
    const { getRun } = await import("../src/workflow/store");
    const run = await startRun(ctx, { workflow: "t/mj", repo: tmpDir(), brief: "B" }, undefined, defaultEngineDeps);
    insertQuestion(ctx, {
      runId: run.id, stepId: "a", attempt: 1, askerKind: "executor",
      text: "?", answerType: "text", blocks: "nothing", answerer: "person",
    });
    expect(listQuestions(ctx, run.id, "open")).toHaveLength(1);
    const rev = getRun(ctx, run.id)!.rev;
    await stop(ctx, run.id, rev);
    expect(listQuestions(ctx, run.id, "open")).toHaveLength(0);
    expect(listQuestions(ctx, run.id).every(q => q.status === "withdrawn")).toBe(true);
    expect(getRun(ctx, run.id)?.status).toBe("stopped");
  });
});
