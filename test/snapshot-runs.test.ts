import { afterAll, beforeAll, expect, test } from "bun:test";
import { composeSnapshotRuns } from "../src/api/read-model/runs";
import { sortItems } from "../src/attention/rules";
import type { AttentionItem } from "../src/attention/types";
import { letterAt } from "../src/workflow/letters";
import {
  getRun,
  insertQuestion,
  insertRun,
  insertStep,
  updateRun,
  workflowDatabase,
  workflowSchemaPresent,
  type RunRow,
} from "../src/workflow/store";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { buildRustProbe, closeRustProbe, rustRequest, readModelCtx } from "./read-model-rust-helpers";
import { toV2Snapshot } from "../src/api/v2-compat";

const NOW = 1_700_000_000;

beforeAll(buildRustProbe, 600_000);
afterAll(closeRustProbe);

test("missing workflow tables yield empty runs", () => {
  const ctx = fakeCtx();
  expect(workflowSchemaPresent(ctx)).toBe(false);
  expect(composeSnapshotRuns(ctx)).toEqual([]);
});

test("letters A–Z then AA; unicode; paused; each waits_on; hidden steps excluded", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  workflowDatabase(ctx);
  const runs: RunRow[] = [];
  for (let i = 0; i < 27; i++) {
    runs.push(insertRun(ctx, {
      workflow: "demo/flow",
      version: 1,
      repo: "/tmp/repo",
      brief: "b",
      title: i === 0 ? "你好 🎉 Ship" : `Run ${i}`,
      priority: i === 1 ? "urgent" : i === 2 ? "background" : "normal",
    }));
  }
  const done = insertRun(ctx, { workflow: "demo/flow", version: 1, repo: "/tmp", brief: "x", title: "Done" });
  updateRun(ctx, done.id, done.rev, { status: "done" });

  insertQuestion(ctx, {
    runId: runs[0]!.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "executor",
    askerTaskId: "t-ask",
    text: "Pick?",
    answerType: "text",
    blocks: "step",
    answerer: "person",
  });

  const r3 = getRun(ctx, runs[3]!.id)!;
  updateRun(ctx, r3.id, r3.rev, { orchestratorState: "blocked", reason: "failed" });

  insertStep(ctx, { runId: runs[4]!.id, stepId: "gen", attempt: 1, status: "waiting" });

  const task = createTask(ctx, { brief: { goal: "work", repo: "/tmp" }, kind: "code", requestedExecutor: null, timeoutS: 60 });
  insertStep(ctx, { runId: runs[5]!.id, stepId: "code", attempt: 1, status: "running", taskId: task.id });

  const root = createTask(ctx, { brief: { goal: "root", repo: "/tmp" }, kind: "workflow-root", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, root.id, t => { t.kind = "workflow-root"; });
  insertStep(ctx, { runId: runs[5]!.id, stepId: "wfroot", attempt: 1, status: "running", taskId: root.id });
  const orch = createTask(ctx, { brief: { goal: "orch", repo: "/tmp" }, kind: "orchestrate", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, orch.id, t => { t.kind = "orchestrate"; });
  insertStep(ctx, { runId: runs[5]!.id, stepId: "orch", attempt: 1, status: "done", taskId: orch.id });

  const r6 = getRun(ctx, runs[6]!.id)!;
  updateRun(ctx, r6.id, r6.rev, { pausedReason: "pacing: strict" });

  const composed = composeSnapshotRuns(ctx);
  expect(composed).toHaveLength(27);

  const byId = new Map(composed.map(r => [r.id, r]));
  expect(byId.get(runs[0]!.id)!.title).toBe("你好 🎉 Ship");
  expect(byId.get(runs[0]!.id)!.waits_on).toBe("you");
  expect(byId.get(runs[3]!.id)!.waits_on).toBe("planner");
  expect(byId.get(runs[4]!.id)!.waits_on).toBe("planner");
  expect(byId.get(runs[5]!.id)!.waits_on).toBe("executors");
  expect(byId.get(runs[5]!.id)!.steps).toEqual({ running: 1, waiting: 0, done: 0, failed: 0 });
  expect(byId.get(runs[6]!.id)!.paused_reason).toBe("pacing: strict");
  expect(byId.get(runs[7]!.id)!.waits_on).toBe("nothing");

  const letters = composed.map(r => r.letter).sort((a, b) => a.length - b.length || a.localeCompare(b));
  expect(letters).toEqual([...Array.from({ length: 26 }, (_, i) => letterAt(i)), "AA"]);

  const urgentIdx = composed.findIndex(r => r.id === runs[1]!.id);
  const backgroundIdx = composed.findIndex(r => r.id === runs[2]!.id);
  expect(urgentIdx).toBeLessThan(backgroundIdx);
});

test("TS and Rust runs JSON are byte-identical over one fixture", async () => {
  const ctx = { ...readModelCtx(), now: NOW };
  workflowDatabase(ctx);
  const a = insertRun(ctx, {
    workflow: "parity/flow",
    version: 1,
    repo: "/tmp",
    brief: "b",
    title: "Parity 日本語",
    priority: "urgent",
  });
  const b = insertRun(ctx, {
    workflow: "parity/flow",
    version: 1,
    repo: "/tmp",
    brief: "b",
    title: "Second",
    priority: "normal",
  });
  insertQuestion(ctx, {
    runId: a.id,
    stepId: "ask",
    attempt: 1,
    askerKind: "human_step",
    text: "Go?",
    answerType: "yes_no",
    blocks: "step",
    answerer: "person",
  });
  insertStep(ctx, { runId: b.id, stepId: "work", attempt: 1, status: "waiting" });
  const b2 = getRun(ctx, b.id)!;
  updateRun(ctx, b2.id, b2.rev, { pausedReason: "person" });

  const ts = composeSnapshotRuns(ctx);
  const rust = await rustRequest(ctx, { op: "runs" });
  expect(JSON.stringify(rust)).toBe(JSON.stringify(ts));
  expect(ts.some(r => r.waits_on === "you")).toBe(true);
  expect(ts.some(r => r.waits_on === "planner")).toBe(true);
}, 120_000);

test("v2 snapshot strips runs", () => {
  const ctx = { ...fakeCtx(), now: NOW };
  workflowDatabase(ctx);
  insertRun(ctx, { workflow: "v2/flow", version: 1, repo: "/tmp", brief: "b", title: "V2" });
  const runs = composeSnapshotRuns(ctx);
  expect(runs.length).toBeGreaterThan(0);
  const v2 = toV2Snapshot({
    seq: 3_000_000_000_000,
    at: NOW,
    mode: "normal",
    tasks: [],
    strategies: [],
    planner: null,
    accounts: [],
    executors: [],
    machine: { used: 0, max: 1, hardCap: null, unlimited: false },
    setup: { complete: true, open: 0, items: [] },
    attention: [],
    counts: { attention: 0, problems: 0, review: 0, running: 0, queued: 0, ready: 0, executors: 0, setupOpen: 0, hostsWithProblems: 0, byRepo: {} },
    today: { since: 0, done: 0, accepted: 0, rejected: 0, failed: 0, byRepo: {} },
    policy: { mode: "normal" },
    pause: null,
    service: { version: "0", protocol: "3.0.0", pid: 1, startedAt: 1, notifier: null },
    hosts: [],
    repos: [],
    runs,
  } as never);
  expect((v2 as { runs?: unknown }).runs).toBeUndefined();
  expect(JSON.stringify(v2)).not.toContain('"waits_on"');
});

test("sortItems ranks by unblocks then run priority", () => {
  const items: AttentionItem[] = [
    {
      id: "question:q_bg",
      kind: "question",
      severity: "blocked",
      repo: null,
      title: "bg",
      detail: "d",
      raisedAt: 5,
      since: 5,
      actions: [],
      notify: "important",
      unblocks: "run",
      run: { id: "r_bg", letter: "B", title: "t", priority: "background" },
    },
    {
      id: "question:q_urgent",
      kind: "question",
      severity: "blocked",
      repo: null,
      title: "u",
      detail: "d",
      raisedAt: 5,
      since: 5,
      actions: [],
      notify: "important",
      unblocks: "run",
      run: { id: "r_u", letter: "A", title: "t", priority: "urgent" },
    },
  ];
  expect(sortItems([...items]).map(i => i.id)).toEqual([
    "question:q_urgent",
    "question:q_bg",
  ]);
});
