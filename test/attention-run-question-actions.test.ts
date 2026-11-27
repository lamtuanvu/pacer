// Batch G / UI-13: first attention action params must succeed via question.answer.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import type { AttentionItem } from "../src/attention/types";
import { apiTask } from "../src/api/read-model/tasks";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import { deriveWorkflowAttention } from "../src/workflow/attention";
import { startRun, type EngineDeps } from "../src/workflow/engine";
import { askQuestion, escalateQuestion } from "../src/workflow/questions";
import { issueRunGrant } from "../src/workflow/run-grant";
import type { WorkflowDef } from "../src/workflow/schema";
import {
  addDefinition,
  getQuestion,
  insertQuestion,
  insertRun,
  insertStep,
  type QuestionAnswerType,
} from "../src/workflow/store";
import { insertTurn } from "../src/workflow/wakeups";
import type { Ctx } from "../src/types";
import type { DelegateInput } from "../src/tasks/api";
import { buildRustProbe, closeRustProbe, rustRequest } from "./read-model-rust-helpers";

const NOW = 1_700_000_000;

const def: WorkflowDef = {
  id: "t/attn-act",
  version: 1,
  steps: {
    ask: { type: "agent", kind: "research", prompt: "Ask" },
    done: { type: "end" },
  },
  edges: [{ from: "ask", to: "done" }],
  entry: "ask",
};

function withStrategy(ctx: Ctx): Ctx {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  return ctx;
}

function executorCtx(base: Ctx, taskId: string): Ctx {
  return { ...base, env: { ...base.env, PACER_ROLE: "executor", PACER_TASK_ID: taskId } };
}

function grantCtx(base: Ctx, runId: string): Ctx {
  insertTurn(base, {
    id: `turn_${runId.slice(-6)}`,
    runId,
    planner: "claude-code",
    status: "running",
    startedAt: base.now,
    deadline: base.now + 1200,
  });
  const bearer = issueRunGrant(base, { runId, turnId: `turn_${runId.slice(-6)}`, deadline: base.now + 600 });
  return { ...base, env: { ...base.env, PACER_RUN_GRANT: bearer } };
}

function personCtx(base: Ctx): Ctx {
  const env = { ...base.env };
  delete env.PACER_RUN_GRANT;
  delete env.PACER_ROLE;
  delete env.PACER_TASK_ID;
  return { ...base, env };
}

function setupExecutorStep(ctx: Ctx): { runId: string; task: TaskRecord } {
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const run = insertRun(ctx, { workflow: "t/attn-act", version: 1, repo: tmpDir(), brief: "B", title: "Act" });
  const task = createTask(ctx, {
    brief: { goal: "Ask", repo: run.repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "running";
    t.run = {
      dir: tmpDir(),
      attempt: 1,
      executor: "codex",
      startedAt: ctx.now,
      mode: "new",
      workdir: run.repo,
      logFile: "/dev/null",
      agentSession: { id: "sid-1", source: "header" },
    };
  });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, taskId: task.id, status: "running" });
  return { runId: run.id, task: readTask(ctx, task.id)! };
}

function needsInputFixture(ctx: Ctx, taskId: string, text: string): void {
  updateTask(ctx, taskId, t => {
    t.state = "needs_input";
    t.question = { text, at: ctx.now };
    t.attempts = [{
      executor: "codex", model: null, startedAt: ctx.now - 1, endedAt: ctx.now,
      exitCode: 0, timedOut: false, limitHit: false, log: "",
    }];
    t.result = {
      status: "needs_input", executor: "codex", model: null, files: "", report: "waiting", backend: "direct",
    };
  });
}

async function personQuestionItem(
  answerType: QuestionAnswerType,
  opts?: {
    text?: string;
    options?: { value: string }[];
    recommended?: string;
    askerKind?: "executor" | "orchestrator" | "human_step";
  },
): Promise<{
  ctx: Ctx;
  task: TaskRecord;
  item: AttentionItem;
  questionId: string;
}> {
  const ctx = fakeCtx({ now: NOW });
  const { runId, task } = setupExecutorStep(ctx);
  const text = opts?.text ?? (
    answerType === "yes_no" ? "Ship?"
      : answerType === "approve_revise" ? "Approve the plan?"
      : answerType === "single" ? "Which DB?"
      : "Free text?"
  );
  const asked = await askQuestion(executorCtx(ctx, task.id), {
    text,
    answerType,
    blocks: "step",
    ...(opts?.options ? { options: opts.options } : {}),
    ...(opts?.recommended ? { recommended: opts.recommended } : {}),
  });
  const orch = grantCtx(ctx, runId);
  const escalated = escalateQuestion(orch, {
    id: asked.id,
    suggested: opts?.recommended ?? "yes",
    reason: "needs human",
    expectRev: asked.rev,
  });
  needsInputFixture(ctx, task.id, text);
  const items = deriveWorkflowAttention(personCtx(ctx));
  const item = items.find(i => i.id === `question:${escalated.id}`);
  expect(item).toBeTruthy();
  return { ctx: personCtx(ctx), task, item: item!, questionId: escalated.id };
}

for (const case_ of [
  {
    name: "yes_no with recommended",
    answerType: "yes_no" as const,
    options: [{ value: "yes" }, { value: "no" }],
    recommended: "yes",
    // UI-3: capitalised label; answer keeps recommended spelling.
    expectFirstLabel: "Yes",
    expectFirstAnswer: "yes",
  },
  {
    name: "yes_no without recommended",
    answerType: "yes_no" as const,
    expectFirstLabel: "Yes",
    expectFirstAnswer: "Yes",
  },
  {
    name: "approve_revise",
    answerType: "approve_revise" as const,
    options: [{ value: "approve" }, { value: "revise" }],
    expectFirstLabel: "Approve",
    expectFirstAnswer: "approve",
  },
  {
    name: "single with options",
    answerType: "single" as const,
    options: [{ value: "postgres" }, { value: "sqlite" }, { value: "mysql" }],
    recommended: "sqlite",
    expectFirstLabel: "sqlite",
    expectFirstAnswer: "sqlite",
  },
]) {
  test(`G: first action for ${case_.name} succeeds through real question.answer`, async () => {
    const { ctx, task, item, questionId } = await personQuestionItem(case_.answerType, {
      options: case_.options,
      recommended: case_.recommended,
    });
    // UI-1: title carries the question; detail opens with the first-button answer cue.
    expect(item.title).toBe(
      case_.answerType === "yes_no" ? "Ship?"
        : case_.answerType === "approve_revise" ? "Approve the plan?"
        : "Which DB?",
    );
    expect(item.detail.startsWith("Act.")).toBe(true);
    expect(item.detail).toContain("Act.");
    expect(item.detail).toContain("Asked by a step.");
    expect(item.detail).toMatch(/Options:/);
    if (case_.recommended) expect(item.detail).toContain(`Recommended: ${case_.recommended}.`);

    const first = item.actions[0];
    expect(first).toBeTruthy();
    expect(first!.op).toBe("question.answer");
    expect(first!.label).toBe(case_.expectFirstLabel);
    expect(first!.params).toEqual({
      id: questionId,
      expect_rev: expect.any(Number),
      answer: case_.expectFirstAnswer,
    });
    expect(first!.params.answer).toBeDefined();

    const spawned: string[] = [];
    const result = await callOp(ctx, "question.answer", first!.params, {
      spawnRunner: (_c, tid) => { spawned.push(tid); return 1; },
    }) as { status: string; answer?: string };
    expect(result.status).toBe("answered");
    expect(result.answer).toBe(case_.expectFirstAnswer);
    expect(getQuestion(ctx, questionId)?.status).toBe("answered");
    expect(readTask(ctx, task.id)?.question?.answer).toBe(case_.expectFirstAnswer);
    expect(spawned).toEqual([task.id]);
  });
}

test("G: text question has no op action and ends with CLI hint", async () => {
  const { item, questionId } = await personQuestionItem("text");
  expect(item.actions.filter(a => a.op === "question.answer")).toEqual([]);
  expect(item.actions).toEqual([]);
  expect(item.title).toBe("Free text?");
  expect(item.detail.startsWith("The first button answers")).toBe(false);
  expect(item.detail.startsWith("Act.")).toBe(true);
  expect(item.detail.endsWith("Asked by a step.")).toBe(true);
  expect(item.detail).toContain("Asked by a step.");
});

test("G: asker cues distinguish human_step / orchestrator / executor", () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const run = insertRun(ctx, { workflow: "t/attn-act", version: 1, repo: tmpDir(), brief: "B", title: "Cues" });
  const cases = [
    { askerKind: "executor" as const, cue: "Asked by a step." },
    { askerKind: "orchestrator" as const, cue: "Asked by the workflow planner." },
    { askerKind: "human_step" as const, cue: "Needs your approval." },
  ];
  for (const c of cases) {
    const q = insertQuestion(ctx, {
      runId: run.id,
      stepId: "ask",
      attempt: 1,
      askerKind: c.askerKind,
      text: "Go?",
      answerType: "yes_no",
      blocks: "step",
      answerer: "person",
    });
    const item = deriveWorkflowAttention(ctx).find(i => i.id === `question:${q.id}`);
    expect(item?.detail).toContain(c.cue);
  }
});

function engineDeps(): EngineDeps {
  const byRequest = new Map<string, TaskRecord>();
  return {
    delegate: async (ctx, input: DelegateInput) => {
      const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
      if (prior) return readTask(ctx, prior.id) ?? prior;
      const task = createTask(ctx, {
        brief: input.brief,
        kind: input.kind ?? null,
        requestedExecutor: null,
        timeoutS: 600,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      if (input.requestId) byRequest.set(input.requestId, task);
      return task;
    },
    stopTask: (ctx, id) => { updateTask(ctx, id, t => { t.state = "stopped"; }); },
  };
}

/** I-1: custom approve_revise options must make actions[0] succeed through question.answer. */
test("H I-1: approve_revise custom options — first action params answer the human-step question", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  const defCustom: WorkflowDef = {
    id: "t/attn-ar-custom",
    version: 1,
    steps: {
      gate: {
        type: "human",
        decision: "must",
        question: { text: "Ship or hold?", kind: "approve_revise", options: ["ship", "hold"] },
      },
      done: { type: "end" },
    },
    edges: [{ from: "gate", to: "done", when: "result.answer == 'ship'" }],
    entry: "gate",
  };
  addDefinition(ctx, defCustom, "id: t/attn-ar-custom\n");
  const run = await startRun(ctx, { workflow: "t/attn-ar-custom", repo: tmpDir(), brief: "B" }, undefined, engineDeps());
  const q = getQuestion(ctx, deriveWorkflowAttention(personCtx(ctx))
    .find(i => i.id.startsWith("question:q_"))!.question!.id as string)!;
  expect(q.answerType).toBe("approve_revise");
  expect(q.options?.map(o => o.value)).toEqual(["ship", "hold"]);

  const item = deriveWorkflowAttention(personCtx(ctx)).find(i => i.id === `question:${q.id}`)!;
  expect(item.title).toBe("Ship or hold?");
  expect(item.detail.startsWith('t/attn-ar-custom.')).toBe(true);
  expect(item.detail).toContain("Options: ship / hold.");
  const first = item.actions[0];
  expect(first).toBeTruthy();
  expect(first!.op).toBe("question.answer");
  expect(first!.params.answer).toBe("ship");
  expect(["ship", "hold"]).toContain(String(first!.params.answer));

  const result = await callOp(personCtx(ctx), "question.answer", first!.params) as { status: string; answer?: string };
  expect(result.status).toBe("answered");
  expect(result.answer).toBe(String(first!.params.answer));
  expect(getQuestion(ctx, q.id)?.status).toBe("answered");
  expect(getQuestion(ctx, q.id)?.answer).toBe(String(first!.params.answer));
});

test("H I-1: approve_revise keeps Approve when options include approve (case-insensitive)", async () => {
  const { item } = await personQuestionItem("approve_revise", {
    options: [{ value: "Approve" }, { value: "revise" }],
    askerKind: "human_step",
  });
  expect(item.actions[0]?.label).toBe("Approve");
  expect(item.actions[0]?.params.answer).toBe("Approve");
});

test("G: prompt_wait first action is Convert to question (params succeed)", () => {
  const ctx = fakeCtx({ now: NOW });
  const task = createTask(ctx, {
    brief: { goal: "fix login", repo: tmpDir() },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const current = updateTask(ctx, task.id, t => {
    t.state = "running";
    t.executor = "codex";
    t.promptWait = { text: "Overwrite? [Y/n]", at: NOW - 40 };
  });
  const items = deriveItems({
    now: ctx.now,
    tasks: [apiTask(ctx, current)],
    executors: [],
    accounts: [],
    planner: null,
    setup: { complete: true, open: 0, items: [] },
    update: null,
    retryTarget: () => null,
  } satisfies RuleInput).filter(i => i.id === `prompt_wait:${task.id}`);
  expect(items[0]?.actions[0]).toMatchObject({
    label: "Convert to question",
    op: "question.convert_prompt",
    params: { id: task.id },
  });
  // UI-1: Convert sentence first, then the captured terminal text.
  expect(items[0]?.detail.startsWith(
    "Convert hands the question to the workflow planner, who answers or asks you.",
  )).toBe(true);
  expect(items[0]?.detail).toContain("Overwrite? [Y/n]");
});

test("H m1: 4+ options lists all and appends CLI hint beyond the 3-button cap", async () => {
  const { item, questionId } = await personQuestionItem("single", {
    options: [
      { value: "one" }, { value: "two" }, { value: "three" }, { value: "four" },
    ],
  });
  expect(item.actions).toHaveLength(3);
  expect(item.detail).toContain("Options: one / two / three / four.");
});

test("H m2: long options are clipped in detail/labels; oversize options get no button", async () => {
  const long40 = "a".repeat(45); // clips to 40 + …
  const over80 = "b".repeat(81); // no button (> 80 code points)
  const { item, questionId } = await personQuestionItem("single", {
    options: [
      { value: "ok" },
      { value: long40 },
      { value: over80 },
    ],
    recommended: "ok",
  });
  expect(item.detail).toContain(`Options: ok / ${"a".repeat(40)}… / ${"b".repeat(40)}….`);
  expect(item.actions.map(a => a.params.answer)).toEqual(["ok", long40]);
  expect(item.actions[1]?.label).toBe(`${"a".repeat(40)}…`);
  expect(item.actions).toHaveLength(2);
});

test("UI-1 / I-1: clipped title ends with … and detail carries Full question", () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const run = insertRun(ctx, { workflow: "t/attn-act", version: 1, repo: tmpDir(), brief: "B", title: "U" });
  // 79 BMP + emoji + y = 81 code points; title clips to 79 + … (marker that text continues).
  const text = `${"x".repeat(79)}\u{1F600}y`;
  const multiline = `Ship the Phase 4\nquestions change\ntonight?`;
  const qLong = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    text,
    answerType: "text",
    blocks: "step",
    answerer: "person",
  });
  const qMulti = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    text: multiline,
    answerType: "yes_no",
    blocks: "step",
    answerer: "person",
  });
  const qPad = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    text: "  leading space?",
    answerType: "text",
    blocks: "step",
    answerer: "person",
  });
  const items = deriveWorkflowAttention(ctx);
  const longItem = items.find(i => i.id === `question:${qLong.id}`)!;
  const multiItem = items.find(i => i.id === `question:${qMulti.id}`)!;
  const padItem = items.find(i => i.id === `question:${qPad.id}`)!;
  const expectedTitle = `${"x".repeat(79)}…`;
  expect(longItem.title).toBe(expectedTitle);
  expect(Array.from(longItem.title).length).toBe(80);
  expect(longItem.title.includes("\uD83D") && !longItem.title.includes("\uDE00")).toBe(false);
  expect(longItem.detail.startsWith("U.")).toBe(true);
  expect(longItem.detail).toContain(`Full question: ${text}.`);
  expect(longItem.detail).not.toContain("\n");
  expect(multiItem.title).toBe("Ship the Phase 4 questions change tonight?");
  expect(multiItem.title).not.toContain("\n");
  expect(multiItem.detail).not.toContain("Full question:");
  expect(multiItem.detail.startsWith('U.')).toBe(true);
  expect(multiItem.actions[0]?.label).toBe("Yes");
  expect(multiItem.actions[0]?.params.answer).toBe("Yes");
  expect(padItem.title).toBe("leading space?");
});

test("I-2: run detail subject collapses newlines, trims shared whitespace, falls back to slug", () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const cases: Array<{ title: string; expectSubject: string }> = [
    { title: " Foo ", expectSubject: "Foo" },
    { title: "  ", expectSubject: "t/attn-act" },
    { title: "Line1\nLine2", expectSubject: "Line1 Line2" },
    { title: "Pad\u00A0", expectSubject: "Pad" },
    { title: "", expectSubject: "t/attn-act" },
  ];
  for (const c of cases) {
    const run = insertRun(ctx, {
      workflow: "t/attn-act", version: 1, repo: tmpDir(), brief: "B", title: c.title,
    });
    const q = insertQuestion(ctx, {
      runId: run.id,
      stepId: "ask",
      attempt: 1,
      askerKind: "executor",
      text: `Q for ${c.expectSubject}`,
      answerType: "text",
      blocks: "step",
      answerer: "person",
    });
    const item = deriveWorkflowAttention(ctx).find(i => i.id === `question:${q.id}`)!;
    expect(item.detail.startsWith(`${c.expectSubject}.`)).toBe(true);
    expect(item.detail).not.toContain(run.id);
  }
});

test("UI-1: untitled run detail uses workflow slug, never a run id", () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const run = insertRun(ctx, { workflow: "t/attn-act", version: 1, repo: tmpDir(), brief: "B", title: "" });
  const q = insertQuestion(ctx, {
    runId: run.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    text: "Untitled?",
    answerType: "text",
    blocks: "step",
    answerer: "person",
  });
  const item = deriveWorkflowAttention(ctx).find(i => i.id === `question:${q.id}`)!;
  expect(item.title).toBe("Untitled?");
  expect(item.detail.startsWith("t/attn-act.")).toBe(true);
  expect(item.detail).not.toContain(run.id);
});

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

function clip40(s: string): string {
  const points = Array.from(s);
  return points.length <= 40 ? s : `${points.slice(0, 40).join("")}…`;
}

test("G / I-3: TS and Rust run-question actions/detail are byte-identical for all variants", async () => {
  const ctx = fakeCtx({ now: NOW });
  withStrategy(ctx);
  addDefinition(ctx, def, "id: t/attn-act\n");
  const repo = tmpDir();
  const run = insertRun(
    { ...ctx, now: NOW - 10 },
    { workflow: "t/attn-act", version: 1, repo, brief: "B", title: "Parity" },
  );
  const runUntitled = insertRun(
    { ...ctx, now: NOW - 10 },
    { workflow: "t/attn-act", version: 1, repo, brief: "B", title: "" },
  );
  const runPadded = insertRun(
    { ...ctx, now: NOW - 10 },
    { workflow: "t/attn-act", version: 1, repo, brief: "B", title: "  Padded  " },
  );
  const runMulti = insertRun(
    { ...ctx, now: NOW - 10 },
    { workflow: "t/attn-act", version: 1, repo, brief: "B", title: "Multi\nLine" },
  );
  // I-3 parity seeds: emoji/ZWJ at 79/80/81, RTL, leading whitespace, CRLF,
  // untitled/padded/multi-line run titles, 1000-char question, option/recommended newlines.
  const zwj = "\u{1F468}\u{200D}\u{1F4BB}"; // 3 code points
  const at79 = `${"a".repeat(76)}${zwj}`; // 79
  const at80 = `${"a".repeat(77)}${zwj}`; // 80
  const at81 = `${"a".repeat(78)}${zwj}`; // 81
  const rtl = "שאלה בעברית עם כיוון RTL";
  const crlf = "Line one\r\nLine two?";
  const thousand = `Q${"z".repeat(999)}`;
  const unicodeText = `${"u".repeat(198)}\u{1F600}${zwj}`;
  const seeds: Array<{
    runId: string;
    answerType: QuestionAnswerType;
    text: string;
    askerKind: "executor" | "orchestrator" | "human_step";
    options?: { value: string }[];
    recommended?: string;
  }> = [
    { runId: run.id, answerType: "yes_no", text: "Ship?", askerKind: "executor", recommended: "yes" },
    { runId: run.id, answerType: "approve_revise", text: "Approve?", askerKind: "human_step", options: [{ value: "approve" }, { value: "revise" }] },
    { runId: run.id, answerType: "approve_revise", text: "Ship or hold?", askerKind: "human_step", options: [{ value: "ship" }, { value: "hold" }] },
    { runId: run.id, answerType: "single", text: "Pick?", askerKind: "orchestrator", options: [{ value: "a" }, { value: "b" }, { value: "c" }], recommended: "b" },
    {
      runId: run.id,
      answerType: "single",
      text: `${unicodeText} "quoted"\nline2`,
      askerKind: "executor",
      options: [
        { value: "short" },
        { value: `long-${"x".repeat(50)}` },
        { value: "opt\nwith\nnewlines" },
        { value: "fourth" },
        { value: "y".repeat(90) },
      ],
      recommended: "rec\nwith\nnewlines-and-more-than-forty-codepoints",
    },
    { runId: run.id, answerType: "text", text: "Notes?", askerKind: "executor" },
    { runId: run.id, answerType: "text", text: at79, askerKind: "executor" },
    { runId: run.id, answerType: "text", text: at80, askerKind: "executor" },
    { runId: run.id, answerType: "text", text: at81, askerKind: "executor" },
    { runId: run.id, answerType: "text", text: rtl, askerKind: "executor" },
    { runId: run.id, answerType: "text", text: "  leading whitespace", askerKind: "executor" },
    { runId: run.id, answerType: "text", text: crlf, askerKind: "executor" },
    { runId: run.id, answerType: "text", text: thousand, askerKind: "executor" },
    { runId: runUntitled.id, answerType: "text", text: "Untitled run?", askerKind: "executor" },
    { runId: runPadded.id, answerType: "text", text: "Padded run?", askerKind: "executor" },
    { runId: runMulti.id, answerType: "text", text: "Multi run?", askerKind: "executor" },
  ];
  for (const s of seeds) {
    insertQuestion({ ...ctx, now: NOW - 10 }, {
      runId: s.runId,
      stepId: "ask",
      attempt: 1,
      askerKind: s.askerKind,
      text: s.text,
      answerType: s.answerType,
      blocks: "step",
      answerer: "person",
      ...(s.options ? { options: s.options } : {}),
      ...(s.recommended ? { recommended: s.recommended } : {}),
    });
  }
  const ts = deriveWorkflowAttention(ctx)
    .filter(i => i.id.startsWith("question:q_"))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rust = (await rustRequest(ctx, { op: "run_questions" }) as AttentionItem[])
    .sort((a, b) => a.id.localeCompare(b.id));
  expect(JSON.stringify(rust)).toBe(JSON.stringify(ts));
  const types = ts.map(i => i.question?.answerType);
  expect(types).toContain("yes_no");
  expect(types).toContain("approve_revise");
  expect(types).toContain("single");
  expect(types).toContain("text");
  expect(ts.find(i => i.question?.answerType === "text" && i.title === "Notes?")?.actions).toEqual([]);
  const yesNo = ts.find(i => i.question?.answerType === "yes_no");
  expect(yesNo?.actions[0]?.label).toBe("Yes");
  expect(yesNo?.actions[0]?.params).toMatchObject({ answer: "yes" });
  expect(yesNo?.detail.startsWith('Parity.')).toBe(true);
  const at79Item = ts.find(i => i.question?.text === at79);
  const at80Item = ts.find(i => i.question?.text === at80);
  const at81Item = ts.find(i => i.question?.text === at81);
  expect(at79Item?.title).toBe(at79);
  expect(at79Item?.detail).not.toContain("Full question:");
  expect(at80Item?.title).toBe(at80);
  expect(at80Item?.detail).not.toContain("Full question:");
  expect(at81Item?.title).toBe(`${Array.from(at81).slice(0, 79).join("")}…`);
  expect(at81Item?.detail).toContain(`Full question: ${at81}.`);
  expect(ts.find(i => i.question?.text === rtl)?.title).toBe(rtl);
  expect(ts.find(i => i.question?.text === "  leading whitespace")?.title).toBe("leading whitespace");
  expect(ts.find(i => i.question?.text === crlf)?.title).toBe("Line one Line two?");
  const thousandItem = ts.find(i => i.question?.text === thousand)!;
  expect(Array.from(thousandItem.title).length).toBe(80);
  expect(thousandItem.title.endsWith("…")).toBe(true);
  expect(thousandItem.detail).toMatch(/Full question: Qz{199}…\./);
  expect(ts.find(i => i.title === "Untitled run?")?.detail.startsWith("t/attn-act.")).toBe(true);
  expect(ts.find(i => i.title === "Padded run?")?.detail.startsWith("Padded.")).toBe(true);
  expect(ts.find(i => i.title === "Multi run?")?.detail.startsWith("Multi Line.")).toBe(true);
  const nlOpts = ts.find(i => typeof i.question?.recommended === "string"
    && String(i.question.recommended).includes("\n"));
  // Options/recommended: newlines collapsed; each value clipped to 40 + … when longer.
  expect(nlOpts?.detail).toContain(
    `Options: short / ${clip40(`long-${"x".repeat(50)}`)} / opt with newlines / fourth / ${clip40("y".repeat(90))}.`,
  );
  expect(nlOpts?.detail).toContain(
    `Recommended: ${clip40("rec with newlines-and-more-than-forty-codepoints")}.`,
  );
  expect(nlOpts?.detail).not.toMatch(/\n/);
  // Newlines collapsed into the title before the 80-code-point clip.
  const unicodeSeed = `${unicodeText} "quoted"\nline2`;
  const unicodeItem = ts.find(i => i.question?.text === unicodeSeed);
  expect(unicodeItem?.title).not.toContain("\n");
  expect(Array.from(unicodeItem?.title ?? "").length).toBe(80);
  expect(unicodeItem?.title.endsWith("…")).toBe(true);
  expect(unicodeItem?.detail).toContain("Full question:");
}, 120_000);
