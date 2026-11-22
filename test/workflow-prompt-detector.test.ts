import { expect, spyOn, test } from "bun:test";
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import {
  addDefinition, insertRun, insertStep, listQuestions, stepByTask, workflowDatabase,
} from "../src/workflow/store";
import {
  convertPromptWaitToQuestion,
  findPromptLikeLine,
  readLogTail,
  refreshAllPromptWaits,
  refreshPromptWait,
} from "../src/workflow/prompt-detector";
import { brokerTick } from "../src/messaging/broker";
import * as sessionSend from "../src/session/send";
import * as msgStore from "../src/messaging/store";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import { apiTask } from "../src/api/read-model/tasks";
import { isWorkflowAttentionItem } from "../src/api/v2-compat";
import type { WorkflowDef } from "../src/workflow/schema";
import * as fs from "node:fs";

const NOW = 1_700_000_000;
const QUIET = 30;

test("prompt patterns: positive fixtures match", () => {
  expect(findPromptLikeLine("Continue? (y/n)")).toBe("Continue? (y/n)");
  expect(findPromptLikeLine("Overwrite file? [Y/n]")).toContain("[Y/n]");
  expect(findPromptLikeLine("Please press enter to continue")).toMatch(/press enter/i);
  expect(findPromptLikeLine("Which option should we take?")).toMatch(/which option/i);
  const numbered = ["1. Red", "2. Blue", "3. Green", "Select a color:"].join("\n");
  expect(findPromptLikeLine(numbered)).toBeTruthy();
});

test("prompt patterns: negative fixtures do not match", () => {
  expect(findPromptLikeLine("Building project...")).toBeNull();
  expect(findPromptLikeLine("tests passed: 12")).toBeNull();
  expect(findPromptLikeLine("yes and no are both fine in prose")).toBeNull();
  expect(findPromptLikeLine("1. only one item")).toBeNull();
});

function seedStepTask(ctx: ReturnType<typeof fakeCtx>, opts: { logText: string; lastOutputAt: number; withStep: boolean }) {
  workflowDatabase(ctx);
  const def: WorkflowDef = {
    id: "t/prompt",
    version: 1,
    steps: { draft: { type: "agent", kind: "feature", prompt: "Draft" }, done: { type: "end" } },
    edges: [{ from: "draft", to: "done" }],
    entry: "draft",
  };
  addDefinition(ctx, def, "test");
  const run = insertRun(ctx, { workflow: def.id, version: 1, repo: tmpDir(), brief: "B", title: "T" });
  const task = createTask(ctx, {
    brief: { repo: tmpDir(), goal: "draft" },
    kind: "feature",
    requestedExecutor: null,
    timeoutS: 600,
  });
  updateTask(ctx, task.id, t => {
    t.state = "running";
    const logDir = join(ctx.pacerHome, "runs", task.id, "1");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "stdout.log");
    writeFileSync(logFile, opts.logText);
    t.run = {
      dir: logDir,
      attempt: 1,
      executor: "codex",
      startedAt: opts.lastOutputAt - 60,
      mode: "new",
      workdir: tmpDir(),
      logFile,
    };
    t.progress = {
      phase: "working",
      lastOutputAt: opts.lastOutputAt,
      lastChangeAt: opts.lastOutputAt,
      files: 0,
      commits: 0,
      logBytes: opts.logText.length,
      host: "local",
      updatedAt: opts.lastOutputAt,
    };
  });
  if (opts.withStep) {
    insertStep(ctx, { runId: run.id, stepId: "draft", attempt: 1, taskId: task.id, status: "running" });
  }
  return { run, task: readTask(ctx, task.id)! };
}

test("ordinary tasks without a step row are never marked", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { task } = seedStepTask(ctx, {
    logText: "Continue? (y/n)\n",
    lastOutputAt: NOW - QUIET - 1,
    withStep: false,
  });
  expect(stepByTask(ctx, task.id)).toBeNull();
  expect(refreshPromptWait(ctx, task.id)).toBeNull();
  expect(readTask(ctx, task.id)?.promptWait).toBeUndefined();
});

test("step-row task with quiet prompt-like output is marked; conversion creates a question and types nothing", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { run, task } = seedStepTask(ctx, {
    logText: "Build done.\nOverwrite? [Y/n]\n",
    lastOutputAt: NOW - QUIET - 5,
    withStep: true,
  });
  const mark = refreshPromptWait(ctx, task.id);
  expect(mark?.text).toMatch(/\[Y\/n\]/i);
  expect(readTask(ctx, task.id)?.promptWait?.text).toMatch(/\[Y\/n\]/i);

  const sendSpy = spyOn(sessionSend, "sendDirectInput").mockResolvedValue({ ok: true } as never);
  const beforeMsgs = msgStore.thread(ctx, task.id).length;
  const q = convertPromptWaitToQuestion(ctx, task.id);
  expect(q.text).toContain(mark!.text);
  expect(q.runId).toBe(run.id);
  expect(q.blocks).toBe("step");
  expect(q.answerer).toBe("orchestrator");
  expect(listQuestions(ctx, run.id, "open").some(row => row.id === q.id)).toBe(true);
  expect(readTask(ctx, task.id)?.promptWait).toBeUndefined();
  expect(sendSpy).not.toHaveBeenCalled();
  expect(msgStore.thread(ctx, task.id).length).toBe(beforeMsgs);
  sendSpy.mockRestore();
});

test("R2-I1: readLogTail reads only the last 16 KiB of a large sparse log", () => {
  const dir = tmpDir();
  const path = join(dir, "huge.log");
  // 50 MiB sparse file with a prompt only in the final bytes.
  const fd = openSync(path, "w");
  try {
    writeSync(fd, Buffer.alloc(1, 0x20), 0, 1, 50 * 1024 * 1024 - 1);
    writeSync(fd, Buffer.from("\nContinue? (y/n)\n"), 0, 17, 50 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  const readSpy = spyOn(fs, "readSync");
  const tail = readLogTail(path);
  expect(tail).toContain("Continue? (y/n)");
  expect(findPromptLikeLine(tail)).toMatch(/\(y\/n\)/i);
  const bytesRead = readSpy.mock.calls.reduce((n, call) => {
    const args = call as unknown as unknown[];
    return n + (Number(args[3]) || 0);
  }, 0);
  expect(bytesRead).toBeLessThanOrEqual(16_384);
  expect(bytesRead).toBeGreaterThan(0);
  readSpy.mockRestore();
});

test("R2-I1: brokerTick drives the detector and marks a quiet step task", async () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { task } = seedStepTask(ctx, {
    logText: "Ready.\nContinue? (y/n)\n",
    lastOutputAt: NOW - QUIET - 5,
    withStep: true,
  });
  expect(readTask(ctx, task.id)?.promptWait).toBeUndefined();
  await brokerTick(ctx, { mode: async () => "normal" });
  expect(readTask(ctx, task.id)?.promptWait?.text).toMatch(/\(y\/n\)/i);
  // Also reachable via the all-tasks refresh used by the tick.
  refreshAllPromptWaits(ctx);
  expect(readTask(ctx, task.id)?.promptWait?.text).toMatch(/\(y\/n\)/i);
});

test("fresh output under 30s does not mark", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { task } = seedStepTask(ctx, {
    logText: "Continue? (y/n)\n",
    lastOutputAt: NOW - 10,
    withStep: true,
  });
  expect(refreshPromptWait(ctx, task.id)).toBeNull();
});

test("attention item exposes answer-in-terminal and convert actions", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  const { task } = seedStepTask(ctx, {
    logText: "Which option do you prefer?\n",
    lastOutputAt: NOW - QUIET - 1,
    withStep: true,
  });
  refreshPromptWait(ctx, task.id);
  const current = readTask(ctx, task.id)!;
  const items = deriveItems({
    now: ctx.now,
    tasks: [apiTask(ctx, current)],
    executors: [],
    accounts: [],
    planner: null,
    setup: { complete: true, open: 0, items: [] },
    update: null,
    retryTarget: () => null,
  } satisfies RuleInput);
  const item = items.find(i => i.id === `prompt_wait:${task.id}`);
  expect(item).toMatchObject({
    kind: "stuck",
    severity: "blocked",
  });
  // UI-1: Convert sentence first, then the captured terminal text.
  expect(item!.detail.startsWith(
    "Convert hands the question to the workflow planner, who answers or asks you.",
  )).toBe(true);
  expect(item!.detail).toContain("Which option do you prefer?");
  expect(item!.actions.map(a => a.op).sort()).toEqual(["question.convert_prompt", "ui.open"]);
  expect(isWorkflowAttentionItem(item!)).toBe(true);
});
