import { expect, spyOn, test, afterEach } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { CallerReach } from "../src/messaging/caller-reach";
import * as callerReach from "../src/messaging/caller-reach";
import * as callerPing from "../src/exec/orca/caller-ping";
import * as plannerResume from "../src/install/planner-resume";
import { setResumeEnabled } from "../src/serve/caller-wake";
import * as caller_wake from "../src/serve/caller-wake";
import { createTask, updateTask } from "../src/tasks/store";
import { join } from "node:path";

afterEach(() => setResumeEnabled(true));
import { callerWake } from "../src/serve/caller-wake";

test("an orca reach is pinged through pingOrcaCaller", async () => {
  const ctx = fakeCtx();
  const reach: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "orca", handle: "handle-1" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockResolvedValue("sent");
  try {
    const result = await callerWake(ctx, reach, "text-1");
    expect(spy).toHaveBeenCalledWith(ctx, "handle-1", "text-1");
    expect(result).toBe("sent");
  } finally {
    spy.mockRestore();
  }
});

test("a non-orca reach is unavailable", async () => {
  const ctx = fakeCtx();
  const tmux: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "tmux", pane: "%1" }, at: 1 };
  const uncontrolled: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "uncontrolled" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockResolvedValue("sent");
  try {
    expect(await callerWake(ctx, tmux, "t")).toBe("unavailable");
    expect(await callerWake(ctx, uncontrolled, "t")).toBe("unavailable");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("an error becomes unavailable", async () => {
  const ctx = fakeCtx();
  const reach: CallerReach = { participant: "p", cwd: tmpDir(), terminal: { kind: "orca", handle: "handle-1" }, at: 1 };
  const spy = spyOn(callerPing, "pingOrcaCaller").mockRejectedValue(new Error("boom"));
  try {
    expect(await callerWake(ctx, reach, "t")).toBe("unavailable");
  } finally {
    spy.mockRestore();
  }
});

const claudeReach = (): CallerReach => ({ participant: "external:claude-code:s1", session: "s1", cwd: tmpDir(), terminal: { kind: "uncontrolled" }, at: 1 });

/** Resume with its preconditions met, unless a test overrides one. */
async function resumeWith(o: { reach?: CallerReach; wrote?: boolean; admitted?: boolean; alive?: "alive" | "gone" | "unknown" } = {}) {
  const reach = o.reach ?? claudeReach();
  const wrote = spyOn(caller_wake.resumeGuards, "executorWroteCallerCwd").mockReturnValue(o.wrote ?? false);
  const admitted = spyOn(caller_wake.resumeGuards, "plannerAdmitted").mockResolvedValue(o.admitted ?? true);
  const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue(o.alive ?? "gone");
  const resumeSpy = spyOn(plannerResume, "resumeCaller").mockResolvedValue("resumed");
  try {
    const out = await callerWake(fakeCtx(), reach, "text", "resume", "task-9");
    return { out, calls: resumeSpy.mock.calls, isAlive: resumeSpy.mock.calls[0]?.[3].isAlive, aliveSpy };
  } finally { wrote.mockRestore(); admitted.mockRestore(); aliveSpy.mockRestore(); resumeSpy.mockRestore(); }
}

test("a closed Claude Code caller is resumed with its session and the task id", async () => {
  const reach = claudeReach();
  const { out, calls } = await resumeWith({ reach });
  expect(out).toBe("resumed");
  expect(calls[0]![1]).toEqual({ kind: "claude-code", session: "s1", cwd: reach.cwd });
  expect(calls[0]![3].task).toBe("task-9");
});

test("resume is refused for Codex and unknown planners, an executor-written checkout, and an exhausted planner", async () => {
  for (const participant of ["external:codex:th-9", "external:opencode:x"])
    expect((await resumeWith({ reach: { ...claudeReach(), participant } })).out).toBe("unavailable");
  expect((await resumeWith({ wrote: true })).out).toBe("unavailable");
  expect((await resumeWith({ admitted: false })).out).toBe("unavailable");
});

test("switching resume off falls through to notification", async () => {
  setResumeEnabled(false);
  expect((await resumeWith()).out).toBe("unavailable");
});

test("the executor-written check covers the task's worktree and an in-place run", () => {
  const ctx = fakeCtx(), shared = tmpDir(), elsewhere = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo: shared }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.placement = { requested: "current", mode: "current" } as typeof x.placement; });
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, shared)).toBe(true);
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, elsewhere)).toBe(false);
  updateTask(ctx, t.id, x => { x.placement = { requested: "new", mode: "new" } as typeof x.placement; x.worktree = join(shared, "wt"); });
  expect(caller_wake.executorWroteCallerCwd(ctx, t.id, shared)).toBe(true);
  expect(caller_wake.executorWroteCallerCwd(ctx, "missing", elsewhere)).toBe(true);
});
