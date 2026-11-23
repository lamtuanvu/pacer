// Round-3 I-1 / I-4: served-path suppression of ordinary question items; narrow asker set.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { createTask, updateTask } from "../src/tasks/store";
import {
  insertQuestion,
  insertRun,
  workflowDatabase,
} from "../src/workflow/store";
import {
  openBlockingPersonQuestionAskerIds,
  suppressOrdinaryQuestionItems,
} from "../src/workflow/attention";
import { deriveTaskItems } from "../src/core/task-attention";
import { apiTask } from "../src/api/read-model/tasks";
import { taskMessageEvents } from "../src/messaging/publish";
import { fakeCtx, tmpDir } from "./helpers";
import { buildRustProbe, closeRustProbe, rustRequest } from "./read-model-rust-helpers";
import type { AttentionItem } from "../src/attention/types";
import type { Ctx } from "../src/types";

const NOW = 1_700_000_000;

function writeStrategy(ctx: Ctx) {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(
    join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n",
  );
}

function seedAskerNeedsInput(ctx: Ctx, brief = "which?") {
  const task = createTask(ctx, {
    brief: { goal: brief, repo: tmpDir() },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  return updateTask(ctx, task.id, t => {
    t.state = "needs_input";
    t.executor = "codex";
    t.question = { text: brief, at: ctx.now - 5 };
  });
}

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

describe("I-1: served path suppresses ordinary question twin", () => {
  test("snapshot.get hides question:<taskId> when a person-blocking structured question covers the asker", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    workflowDatabase(ctx);
    const asker = seedAskerNeedsInput(ctx, "Ship?");
    const run = insertRun(ctx, {
      workflow: "t/r3i1", version: 1, repo: tmpDir(), brief: "B", title: "Ship?",
    });
    const q = insertQuestion(ctx, {
      runId: run.id,
      stepId: "ask",
      attempt: 1,
      askerKind: "executor",
      askerTaskId: asker.id,
      text: "Ship?",
      answerType: "yes_no",
      blocks: "step",
      answerer: "person",
    });

    const snap = (await callOp(ctx, "snapshot.get", {})) as {
      snapshot: { attention: { id: string }[] };
    };
    const ids = snap.snapshot.attention.map(a => a.id);
    expect(ids).toContain(`question:${q.id}`);
    expect(ids).not.toContain(`question:${asker.id}`);
  });

  test("taskMessageEvents applies the shared asker filter before publishing", () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const asker = seedAskerNeedsInput(ctx, "Ship?");
    const run = insertRun(ctx, {
      workflow: "t/r3i1p", version: 1, repo: tmpDir(), brief: "B", title: "Ship?",
    });
    insertQuestion(ctx, {
      runId: run.id,
      stepId: "ask",
      attempt: 1,
      askerKind: "executor",
      askerTaskId: asker.id,
      text: "Ship?",
      answerType: "yes_no",
      blocks: "step",
      answerer: "person",
    });
    const ordinary = deriveTaskItems({
      now: ctx.now,
      tasks: [apiTask(ctx, asker)].map(t => ({ ...t, title: t.fullTitle ?? t.title })),
      executors: [],
      accounts: [],
      planner: null,
      setup: { complete: true, open: 0, items: [] },
      update: null,
      retryTarget: () => null,
    });
    expect(ordinary.some(i => i.id === `question:${asker.id}`)).toBe(true);
    const filtered = suppressOrdinaryQuestionItems(ordinary, openBlockingPersonQuestionAskerIds(ctx));
    expect(filtered.some(i => i.id === `question:${asker.id}`)).toBe(false);
    // Publish path must not resurrect the ordinary item (message entity only / removed).
    const events = taskMessageEvents(ctx, asker.id);
    expect(events.some(e =>
      e.type === "entity" && e.data.kind === "attention" && e.data.id === `question:${asker.id}` && !e.data.removed,
    )).toBe(false);
  });
});

describe("I-4: suppression only for person-blocking questions", () => {
  test("blocks:nothing answerer:orchestrator does not suppress the ordinary needs_input item", async () => {
    const ctx = fakeCtx({ now: NOW });
    writeStrategy(ctx);
    workflowDatabase(ctx);
    const asker = seedAskerNeedsInput(ctx, "which db?");
    const run = insertRun(ctx, {
      workflow: "t/r3i4", version: 1, repo: tmpDir(), brief: "B", title: "Run",
    });
    insertQuestion(ctx, {
      runId: run.id,
      stepId: "info",
      attempt: 1,
      askerKind: "executor",
      askerTaskId: asker.id,
      text: "FYI for orch",
      answerType: "text",
      blocks: "nothing",
      answerer: "orchestrator",
    });
    expect(openBlockingPersonQuestionAskerIds(ctx).has(asker.id)).toBe(false);

    const snap = (await callOp(ctx, "snapshot.get", {})) as {
      snapshot: { attention: { id: string }[] };
    };
    expect(snap.snapshot.attention.some(a => a.id === `question:${asker.id}`)).toBe(true);
  });
});

describe("I-1: TS+Rust byte-identical ordinary + run + branch fixture", () => {
  test("run/branch question items match; ordinary asker item suppressed in both", async () => {
    const ctx = fakeCtx({ now: NOW });
    workflowDatabase(ctx);
    const asker = seedAskerNeedsInput(ctx, "Ship?");
    const runQ = insertQuestion(
      { ...ctx, now: NOW - 20 },
      {
        runId: insertRun({ ...ctx, now: NOW - 20 }, {
          workflow: "t/parity", version: 1, repo: tmpDir(), brief: "B", title: "Run Q",
        }).id,
        stepId: "ask",
        attempt: 1,
        askerKind: "executor",
        askerTaskId: asker.id,
        text: "Run pick?",
        answerType: "single",
        options: [{ value: "a" }, { value: "b" }],
        recommended: "a",
        blocks: "step",
        answerer: "person",
      },
    );
    const branchQ = insertQuestion(
      { ...ctx, now: NOW - 10 },
      {
        runId: insertRun({ ...ctx, now: NOW - 10 }, {
          workflow: "t/parity", version: 1, repo: tmpDir(), brief: "B", title: "Branch Q",
        }).id,
        stepId: "branch",
        attempt: 1,
        askerKind: "executor",
        askerTaskId: "t-other",
        text: "Branch pick?",
        answerType: "single",
        options: [{ value: "x" }, { value: "y" }],
        recommended: "x",
        blocks: "branch",
        answerer: "person",
      },
    );

    const { deriveWorkflowAttention } = await import("../src/workflow/attention");
    const tsStructured = deriveWorkflowAttention(ctx)
      .filter(i => i.id.startsWith("question:q_"))
      .sort((a, b) => a.id.localeCompare(b.id));
    const rustStructured = ((await rustRequest(ctx, { op: "run_questions" })) as AttentionItem[])
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(JSON.stringify(rustStructured)).toBe(JSON.stringify(tsStructured));
    expect(tsStructured.map(i => i.id).sort()).toEqual(
      [`question:${branchQ.id}`, `question:${runQ.id}`].sort(),
    );

    // Ordinary twin suppressed for the step asker; unrelated ordinary kept.
    expect(openBlockingPersonQuestionAskerIds(ctx).has(asker.id)).toBe(true);
    expect(openBlockingPersonQuestionAskerIds(ctx).has("t-other")).toBe(true);
  }, 120_000);
});
