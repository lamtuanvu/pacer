import { expect, test } from "bun:test";
import { markFreshness, staleAfterS } from "../src/usage/freshness";
import type { UsageReading, UsageWindow } from "../src/types";

const w = (name: string, lengthS: number, extra: Partial<UsageWindow> = {}): UsageWindow => ({ name, usedPct: 50, resetsAt: null, lengthS, paced: lengthS >= 86400, ...extra });
const now = 1_000_000;

test("short windows go stale after 2 h, long ones after 24 h", () => {
  expect(staleAfterS(w("5h", 5 * 3600))).toBe(7200);
  expect(staleAfterS(w("6h", 6 * 3600))).toBe(7200);
  expect(staleAfterS(w("weekly", 7 * 86400))).toBe(86400);
});

test("a 3 h old reading: 5 h window stale, weekly fresh, reading not stale", () => {
  const r: UsageReading = { windows: [w("weekly", 7 * 86400), w("5h", 5 * 3600)], capturedAt: now - 3 * 3600, stale: false, source: "status-line" };
  const m = markFreshness(r, now);
  expect(m.windows.map((x) => [x.name, x.stale])).toEqual([["weekly", false], ["5h", true]]);
  expect(m.stale).toBe(false);
});

test("all windows stale makes the reading stale; no capturedAt is stale", () => {
  expect(markFreshness({ windows: [w("weekly", 7 * 86400)], capturedAt: now - 3 * 86400, stale: false, source: "session-log" }, now).stale).toBe(true);
  expect(markFreshness({ windows: [w("weekly", 7 * 86400)], capturedAt: null, stale: false, source: "status-line" }, now).stale).toBe(true);
});

test("limit windows and reactive/unmetered readings are never stale; empty readings are not stale", () => {
  const lim = w("limit", 3600, { usedPct: 100, paced: false });
  expect(markFreshness({ windows: [lim], capturedAt: null, stale: false }, now).windows[0].stale).toBe(false);
  expect(markFreshness({ windows: [w("limit", 0)], capturedAt: now - 10 * 86400, stale: false, source: "reactive" }, now).stale).toBe(false);
  expect(markFreshness({ windows: [], capturedAt: null, stale: false, source: "status-line" }, now).stale).toBe(false);
});
