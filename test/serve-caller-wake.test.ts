import { expect, spyOn, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import type { CallerReach } from "../src/messaging/caller-reach";
import * as callerPing from "../src/exec/orca/caller-ping";
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