import { expect, test } from "bun:test";
import { EXHAUSTED_PCT, NEAR_LIMIT_PCT, LIMIT_WINDOW_LENGTH_S, AUTH_LIFETIME_S, EXECUTION_LIFETIME_S,
  SPENDING_LIFETIME_S, AVAILABILITY_FALLBACK_S, OBSERVATION_EXPIRY_S, USAGE_MEMO_S, markFreshness, staleAfterS } from "../src/usage/freshness";
import constants from "../src/usage/freshness.constants.json";
import type { UsageReading, UsageWindow } from "../src/types";

const w = (name: string, lengthS: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ name, usedPct: 50, resetsAt: null, lengthS, paced: lengthS >= 86400, ...extra });
const now = 1_000_000;

test("every threshold is owned by freshness.ts and sourced from the constants file", () => {
  expect([EXHAUSTED_PCT, NEAR_LIMIT_PCT, LIMIT_WINDOW_LENGTH_S, AUTH_LIFETIME_S, EXECUTION_LIFETIME_S,
    SPENDING_LIFETIME_S, AVAILABILITY_FALLBACK_S, OBSERVATION_EXPIRY_S, USAGE_MEMO_S])
    .toEqual([constants.exhaustedPct, constants.nearLimitPct, constants.limitWindowLengthS, constants.authLifetimeS,
      constants.executionLifetimeS, constants.spendingLifetimeS, constants.availabilityFallbackS,
      constants.observationExpiryS, constants.usageMemoS]);
  expect(EXHAUSTED_PCT).toBe(97);
  expect(NEAR_LIMIT_PCT).toBe(90);
  expect(LIMIT_WINDOW_LENGTH_S).toBe(21600);
  expect(AUTH_LIFETIME_S).toBe(7200);
  expect(EXECUTION_LIFETIME_S).toBe(7200);
  expect(SPENDING_LIFETIME_S).toBe(7200);
  expect(AVAILABILITY_FALLBACK_S).toBe(86400);
  expect(OBSERVATION_EXPIRY_S).toBe(60);
  expect(USAGE_MEMO_S).toBe(60);
});

test("short windows go stale after 2 h, long ones after 24 h", () => {
  expect(staleAfterS(w("5h", 5 * 3600))).toBe(7200);
  expect(staleAfterS(w("6h", 6 * 3600))).toBe(7200);
  expect(staleAfterS(w("weekly", 7 * 86400))).toBe(86400);
});

test("a 3 h old reading: 5 h window stale, weekly fresh, reading partially stale", () => {
  const r: UsageReading = { windows: [w("weekly", 7 * 86400), w("5h", 5 * 3600)], capturedAt: now - 3 * 3600, stale: false, source: "status-line" };
  const m = markFreshness(r, now);
  expect(m.windows.map((x) => [x.name, x.stale])).toEqual([["weekly", false], ["5h", true]]);
  expect(m.stale).toBe(true);
});

test("all windows stale makes the reading stale; no capturedAt is stale", () => {
  expect(markFreshness({ windows: [w("weekly", 7 * 86400)], capturedAt: now - 3 * 86400, stale: false, source: "session-log" }, now).stale).toBe(true);
  expect(markFreshness({ windows: [w("weekly", 7 * 86400)], capturedAt: null, stale: false, source: "status-line" }, now).stale).toBe(true);
});

test("near-limit observations expire by age even before their reset", () => {
  for (const [usedPct, resetsAt, stale] of [
    [90, now + 3600, true],
    [100, now + 3600, true],
    [50, now + 3600, true],
    [89, now + 3600, true],
    [99, null, true],
    [99, now, true],
    [99, now - 1, true],
  ] as const) {
    const r: UsageReading = { windows: [w("5h", 5 * 3600, { usedPct, resetsAt })], capturedAt: now - 3 * 3600, stale: false, source: "status-line" };
    const m = markFreshness(r, now);
    expect(m.windows[0].stale).toBe(stale);
    expect(m.stale).toBe(stale);
  }
});

test("limit windows and reactive/unmetered readings are never stale; empty readings are not stale", () => {
  const lim = w("limit", 3600, { usedPct: 100, paced: false });
  expect(markFreshness({ windows: [lim], capturedAt: null, stale: false }, now).windows[0].stale).toBe(false);
  expect(markFreshness({ windows: [w("limit", 0)], capturedAt: now - 10 * 86400, stale: false, source: "reactive" }, now).stale).toBe(false);
  expect(markFreshness({ windows: [], capturedAt: null, stale: false, source: "status-line" }, now).stale).toBe(false);
});

test("reset and missing observation boundaries remain historical", () => {
  const reading = { windows: [w("5h", 18000, { usedPct: 100, resetsAt: now })], capturedAt: now - 60, stale: false };
  expect(markFreshness(reading, now).windows[0].stale).toBe(true);
  expect(markFreshness({ ...reading, capturedAt: now + 1 }, now).stale).toBe(true);
});
