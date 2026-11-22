// Round-3 I-3: Rust prompt_wait parity with TS; v2 strips promptWait from tasks.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { deriveItems, type RuleInput } from "../src/attention/rules";
import { apiTask } from "../src/api/read-model/tasks";
import { toV2OpResult } from "../src/api/v2-compat";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";
import { buildRustProbe, closeRustProbe, rustRequest } from "./read-model-rust-helpers";
import type { AttentionItem } from "../src/attention/types";

const NOW = 1_700_000_000;

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

test("I-3: TS and Rust prompt_wait attention items are byte-identical", async () => {
  const ctx = fakeCtx({ now: NOW });
  const task = createTask(ctx, {
    brief: { goal: "fix the login form", repo: tmpDir() },
    kind: null,
    requestedExecutor: "codex",
    timeoutS: 60,
  });
  const current = updateTask(ctx, task.id, t => {
    t.state = "running";
    t.executor = "codex";
    t.promptWait = { text: "Overwrite? [Y/n]", at: NOW - 40 };
  });
  const api = apiTask(ctx, current);
  expect(api.promptWait).toEqual({ text: "Overwrite? [Y/n]", at: NOW - 40 });

  const ts = deriveItems({
    now: ctx.now,
    tasks: [api],
    executors: [],
    accounts: [],
    planner: null,
    setup: { complete: true, open: 0, items: [] },
    update: null,
    retryTarget: () => null,
  } satisfies RuleInput).filter(i => i.id === `prompt_wait:${task.id}`);

  // Raise via Rust with the same api-task shape (includes promptWait pass-through).
  const rustTasks = await rustRequest(ctx, { op: "tasks", records: [current] }) as Record<string, unknown>[];
  expect(rustTasks[0]?.promptWait).toEqual({ text: "Overwrite? [Y/n]", at: NOW - 40 });

  const rustRaised = await rustRequest(ctx, {
    op: "raised",
    tasks: rustTasks,
    executors: [],
    accounts: [],
    setup: { items: [] },
    planner: null,
    canPair: false,
  }) as AttentionItem[];
  const rust = rustRaised.filter(i => i.id === `prompt_wait:${task.id}`);
  expect(JSON.stringify(rust)).toBe(JSON.stringify(ts));
  expect(rust[0]?.actions.map(a => a.op)).toEqual(["question.convert_prompt", "ui.open"]);
  expect(ts[0]?.actions[0]?.label).toBe("Convert to question");
}, 120_000);

test("I-3 / M-g: v2 task JSON strips promptWait", () => {
  const task = {
    id: "t-1",
    title: "x",
    fullTitle: "full",
    promptWait: { text: "Y/n", at: 1 },
    rev: 1,
  };
  const v2 = toV2OpResult("task.get", task) as Record<string, unknown>;
  expect(v2.promptWait).toBeUndefined();
  expect(v2.fullTitle).toBeUndefined();
  expect(v2.id).toBe("t-1");
});
