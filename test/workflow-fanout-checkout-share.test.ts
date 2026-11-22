import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { checkoutOccupied } from "../src/plugins/executor-checkout";
import { createTask, updateTask } from "../src/tasks/store";
import { insertRun, insertStep } from "../src/workflow/store";
import { fakeCtx, gitRepo } from "./helpers";

/**
 * Live P2: fanout research branches use placement mode current (read-only kind).
 * Sharing is only for workflow step tasks of the SAME run; ordinary research
 * delegates and conversation lanes stay exclusive.
 */
function researchOnCurrent(ctx: ReturnType<typeof fakeCtx>, repo: string, goal: string) {
  const task = createTask(ctx, {
    brief: { goal, repo },
    kind: "research",
    requestedExecutor: null,
    timeoutS: 60,
  });
  return updateTask(ctx, task.id, t => {
    t.state = "running";
    t.placement = { requested: "auto", mode: "current", why: "read-only kind" };
    t.runnerPid = process.pid;
    t.executor = "claude-code";
  });
}

describe("same-run workflow research shares current checkout", () => {
  test("research+research same run share", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    const run = insertRun(ctx, { workflow: "t/share", version: 1, repo, brief: "B" });
    const a = researchOnCurrent(ctx, repo, "Probe x");
    const b = createTask(ctx, {
      brief: { goal: "Probe y", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, b.id, t => {
      t.state = "running";
      t.placement = { requested: "auto", mode: "current", why: "read-only kind" };
    });
    insertStep(ctx, { runId: run.id, stepId: "fan", attempt: 1, branch: "x", status: "running", taskId: a.id });
    insertStep(ctx, { runId: run.id, stepId: "fan", attempt: 1, branch: "y", status: "running", taskId: b.id });
    expect(checkoutOccupied(ctx, b.id, repo)).toBe(false);
  });

  test("research blocks a writer", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    const run = insertRun(ctx, { workflow: "t/share", version: 1, repo, brief: "B" });
    const reader = researchOnCurrent(ctx, repo, "Probe");
    insertStep(ctx, { runId: run.id, stepId: "probe", attempt: 1, status: "running", taskId: reader.id });
    const writer = createTask(ctx, {
      brief: { goal: "Edit", repo },
      kind: "feature",
      requestedExecutor: null,
      timeoutS: 60,
    });
    expect(checkoutOccupied(ctx, writer.id, repo)).toBe(true);
  });

  test("writer blocks research", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    const writer = createTask(ctx, {
      brief: { goal: "Edit", repo },
      kind: "feature",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, writer.id, t => {
      t.state = "running";
      t.placement = { requested: "current", mode: "current", why: "requested" };
      t.runnerPid = process.pid;
      t.executor = "claude-code";
    });
    const reader = createTask(ctx, {
      brief: { goal: "Probe", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    expect(checkoutOccupied(ctx, reader.id, repo)).toBe(true);
  });

  test("two ordinary (non-workflow) research tasks do NOT share", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    researchOnCurrent(ctx, repo, "Probe x");
    const b = createTask(ctx, {
      brief: { goal: "Probe y", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    expect(checkoutOccupied(ctx, b.id, repo)).toBe(true);
  });

  test("a conversation lane does not share", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    const lane = createTask(ctx, {
      brief: { goal: "Chat", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
      interactionMode: "conversation",
    });
    updateTask(ctx, lane.id, t => {
      t.state = "running";
      t.placement = { requested: "current", mode: "current", why: "conversation" };
      t.runnerPid = process.pid;
      t.executor = "claude-code";
      t.interactionMode = "conversation";
    });
    const other = createTask(ctx, {
      brief: { goal: "Probe", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    expect(checkoutOccupied(ctx, other.id, repo)).toBe(true);
  });
});
