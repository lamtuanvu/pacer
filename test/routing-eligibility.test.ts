import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { computeStatus } from "../src/engine/status";
import { rankExecutors } from "../src/engine/rank";
import { decideGuard } from "../src/guard/guard";
import { defaultHooks } from "../src/classify/hooks";
import type { UsageReading } from "../src/types";
import { fakeCtx, withLoginIndicators } from "./helpers";

const strategy = () => validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} }, pacing: { policy: "priority" } }, "/x");
function measured(now: number, usedPct = 10): UsageReading {
  return { source: "session-log", capturedAt: now - 10, stale: false, windows: [
    { name: "weekly", usedPct, resetsAt: now + 86400, lengthS: 604800, paced: true },
  ] };
}

test("confirmed eligible always precedes uncertain fallback, including configured selection", async () => {
  const ctx = withLoginIndicators(fakeCtx()), s = strategy();
  const st = await computeStatus(ctx, s, { profile: null, readings: new Map([
    ["claude-code", measured(ctx.now)], ["codex", { windows: [], capturedAt: null, stale: false }],
    ["cursor", { windows: [], capturedAt: ctx.now, stale: false, source: "reactive" }],
  ]) });
  const ranking = rankExecutors(null, s, Object.fromEntries(st.providers.map(p => [p.id, p])), { executors: ["codex", "cursor"], order: "configured" });
  expect(ranking.ranked.map(r => r.id)).toEqual(["cursor", "codex"]);
  expect(ranking.ranked[1].eligibility?.state).toBe("uncertain");
  expect(ranking.ranked[1].fallback).toBe("uncertain");
});

test("guard allows local work with only uncertain alternatives and suggests a confirmed eligible executor", async () => {
  const ctx = withLoginIndicators(fakeCtx()), s = strategy();
  s.runners.cursor.enabled = false;
  const readings = new Map<string, UsageReading>([["claude-code", measured(ctx.now)], ["codex", { windows: [], capturedAt: null, stale: false }]]);
  let st = await computeStatus(ctx, s, { profile: null, readings });
  st.mode = "normal";
  const input = { subagentType: "general-purpose", prompt: "implement" };
  expect((await decideGuard(ctx, input, { hooks: defaultHooks, status: async () => st })).allow).toBe(true);
  s.runners.cursor.enabled = true;
  st = await computeStatus(ctx, s, { profile: null, readings });
  st.mode = "normal";
  const result = await decideGuard(ctx, input, { hooks: defaultHooks, status: async () => st });
  expect(result.allow).toBe(false);
  expect(result.reason).toContain("top executor now: cursor");
});

test("availability excludes missing subscription, transient errors stay uncertain, valid exhaustion forbids paid overflow", async () => {
  for (const [reading, expected] of [
    [{ windows: [], capturedAt: 100, stale: false, source: "provider-cli", availability: { state: "unavailable", reason: "subscription_missing", validUntil: 700 } }, "ineligible"],
    [{ windows: [], capturedAt: null, stale: false, error: "timeout" }, "uncertain"],
    [{ ...measured(100, 100), spending: { creditsAvailable: true, creditBalance: 10, paidConsumption: "unknown" } }, "ineligible"],
  ] as const) {
    const ctx = withLoginIndicators(fakeCtx({ now: 100 })), s = strategy();
    const st = await computeStatus(ctx, s, { profile: null, readings: new Map([["codex", reading as UsageReading]]) });
    expect(st.providers.find(p => p.id === "codex")?.eligibility?.state).toBe(expected);
  }
});
