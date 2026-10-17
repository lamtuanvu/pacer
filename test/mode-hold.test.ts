import { expect, test } from "bun:test";
import { holdMode, readHold, releaseMode } from "../src/core/mode-hold";
import { computeStatus } from "../src/engine/status";
import { validateStrategy } from "../src/config/strategy";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";
import type { UsageReading } from "../src/types";
const strategy = () => validateStrategy({planner: "claude-code", providers: {"claude-code": {}, codex: {}}}, "test");
test("hold defaults to planner reset and overrides strict mode only until expiry", async () => {
  const ctx = fakeCtx(), s = strategy(), until = ctx.now + 86400;
  // Native usage fixture lets the public op discover the planner window.
  const { claudeCachePaths } = await import("../src/usage/claude");
  await Bun.write(claudeCachePaths(ctx)[0], JSON.stringify({seven_day: {used_percentage: 90, resets_at: until}, captured_at: ctx.now}));
  const opts = {profile: null, readings: new Map<string, UsageReading>([["claude-code", {windows: [{name: "weekly", usedPct: 90, resetsAt: until, lengthS: 604800, paced: true}], capturedAt: ctx.now, stale: false}]])};
  expect((await computeStatus(ctx, s, opts)).mode).toBe("strict");
  expect(await holdMode(ctx, {mode: "normal"}, s)).toEqual({mode: "normal", until});
  const held = await computeStatus(ctx, s, opts);
  expect(held.mode).toBe("normal");
  expect(held.modeHold).toEqual({mode: "normal", until});
  const expired = {...ctx, now: until};
  expect(readHold(expired)).toBeNull();
  expect((await computeStatus(expired, s, {profile: null, readings: new Map([["claude-code", {windows: [{name: "weekly", usedPct: 90, resetsAt: until + 86400, lengthS: 604800, paced: true}], capturedAt: until, stale: false}]])})).mode).toBe("strict");
  expect(releaseMode(ctx)).toEqual({released: true});
  expect(readHold(ctx)).toBeNull();
});
test("explicit holds validate mode and future timestamp; unknown reset uses seven days", async () => {
  const ctx = fakeCtx(), s = strategy();
  expect(await holdMode(ctx, {mode: "relaxed"}, s)).toEqual({mode: "relaxed", until: ctx.now + 604800});
  expect(await callOp(ctx, "mode.hold", {mode: "emergency", until: ctx.now + 60})).toEqual({mode: "emergency", until: ctx.now + 60});
  await expect(callOp(ctx, "mode.hold", {mode: "invalid"})).rejects.toMatchObject({code: "invalid_input"});
  await expect(callOp(ctx, "mode.hold", {mode: "normal", until: ctx.now})).rejects.toMatchObject({code: "invalid_input"});
  expect(await callOp(ctx, "mode.release", {})).toEqual({released: true});
});
