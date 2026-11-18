import { expect, spyOn, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { CallerReach } from "../src/messaging/caller-reach";
import * as callerReach from "../src/messaging/caller-reach";
import * as callerPing from "../src/exec/orca/caller-ping";
import * as plannerResume from "../src/install/planner-resume";
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

test("resume derives the planner kind and refuses while the caller is not gone", async () => {
  {
    const ctx = fakeCtx();
    const reach: CallerReach = { participant: "external:codex:th-9", session: "th-9", cwd: tmpDir(), terminal: { kind: "orca", handle: "h" }, at: 1 };
    const aliveSpy = spyOn(callerReach, "callerAlive");
    const resumeSpy = spyOn(plannerResume, "resumeCaller").mockResolvedValue("resumed");
    try {
      aliveSpy.mockResolvedValue("gone");
      expect(await callerWake(ctx, reach, "text", "resume", "task-9")).toBe("resumed");
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      const args = resumeSpy.mock.calls[0]!;
      expect(args[1]).toEqual({ kind: "codex", session: "th-9", cwd: reach.cwd });
      expect(args[3].task).toBe("task-9");
      aliveSpy.mockResolvedValue("alive");
      expect(await args[3].isAlive()).toBe(true);
      aliveSpy.mockResolvedValue("gone");
      expect(await args[3].isAlive()).toBe(false);
    } finally {
      aliveSpy.mockRestore();
      resumeSpy.mockRestore();
    }
  }
  {
    const ctx = fakeCtx();
    const reach: CallerReach = { participant: "external:claude-code:s1", session: "s1", cwd: tmpDir(), terminal: { kind: "orca", handle: "h" }, at: 1 };
    const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("gone");
    const resumeSpy = spyOn(plannerResume, "resumeCaller").mockResolvedValue("resumed");
    try {
      expect(await callerWake(ctx, reach, "text", "resume", "task-1")).toBe("resumed");
      const args = resumeSpy.mock.calls[0]!;
      expect(args[1]).toEqual({ kind: "claude-code", session: "s1", cwd: reach.cwd });
    } finally {
      aliveSpy.mockRestore();
      resumeSpy.mockRestore();
    }
  }
  {
    const ctx = fakeCtx();
    const reach: CallerReach = { participant: "external:opencode:x", session: "x", cwd: tmpDir(), terminal: { kind: "orca", handle: "h" }, at: 1 };
    const aliveSpy = spyOn(callerReach, "callerAlive").mockResolvedValue("gone");
    const resumeSpy = spyOn(plannerResume, "resumeCaller").mockResolvedValue("resumed");
    try {
      expect(await callerWake(ctx, reach, "text", "resume", "task-1")).toBe("unavailable");
      expect(resumeSpy).not.toHaveBeenCalled();
    } finally {
      aliveSpy.mockRestore();
      resumeSpy.mockRestore();
    }
  }
});