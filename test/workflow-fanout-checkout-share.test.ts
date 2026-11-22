import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { checkoutOccupied } from "../src/plugins/executor-checkout";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo } from "./helpers";

/**
 * Live P2: fanout research branches use placement mode current (read-only kind).
 * With local_max_tasks > 1 they must share the checkout; exclusive ownership
 * made the second branch fail with "current checkout is owned by another task".
 */
describe("read-only research shares current checkout", () => {
  test("checkoutOccupied is false when the other running task is research", () => {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const repo = gitRepo();
    const a = createTask(ctx, {
      brief: { goal: "Probe x", repo },
      kind: "research",
      requestedExecutor: null,
      timeoutS: 60,
    });
    updateTask(ctx, a.id, t => {
      t.state = "running";
      t.placement = { requested: "auto", mode: "current", why: "read-only kind" };
      t.runnerPid = process.pid;
      t.executor = "claude-code";
    });
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
    expect(checkoutOccupied(ctx, b.id, repo)).toBe(false);
  });

  test("checkoutOccupied stays true when a non-research task owns current", () => {
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
});
