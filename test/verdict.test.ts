import { expect, test } from "bun:test";
import { bindingWindow, evaluateWindow, type WindowStatus } from "../src/engine/verdict";
import { plannerMode } from "../src/engine/mode";
import type { UsageWindow } from "../src/types";
import { localTs } from "./helpers";

const th = { ahead: 10, behind: -10, paceScale: 1 };
const start = localTs(2026, 10, 5);
const weekly = (usedPct: number | null, resetsAt: number | null = start + 7 * 86400): UsageWindow =>
  ({ name: "weekly", usedPct, resetsAt, lengthS: 7 * 86400, paced: true });

test("paced verdicts against calendar pace", () => {
  const mid = start + 3.5 * 86400; // pace 50
  expect(evaluateWindow(weekly(50), mid, null, th)).toMatchObject({ verdict: "ON_PACE", pace: 50, delta: 0 });
  expect(evaluateWindow(weekly(70), mid, null, th).verdict).toBe("AHEAD");
  expect(evaluateWindow(weekly(30), mid, null, th).verdict).toBe("BEHIND");
  expect(evaluateWindow(weekly(98), mid, null, th).verdict).toBe("EXHAUSTED");
  expect(evaluateWindow(weekly(null), mid, null, th).verdict).toBe("UNKNOWN");
});

test("EXPIRING when 9 or fewer active hours remain with 25%+ unused", () => {
  const late = start + 7 * 86400 - 8 * 3600;
  expect(evaluateWindow(weekly(17), late, null, th)).toMatchObject({ verdict: "EXPIRING" });
  expect(evaluateWindow(weekly(90), late, null, th).verdict).toBe("ON_PACE");
});

test("past resetsAt preserves historical usage without claiming current quota", () => {
  const w = evaluateWindow(weekly(100, start - 60), start, null, th);
  expect(w).toMatchObject({ usedPct: 100, resetsAt: start - 60, rolled: true, verdict: "UNKNOWN" });
});

test("unpaced windows only check limits; planner paceScale lowers the target", () => {
  const five = (u: number): UsageWindow => ({ name: "5h", usedPct: u, resetsAt: start + 3600, lengthS: 18000, paced: false });
  expect(evaluateWindow(five(50), start, null, th).verdict).toBe("OK");
  expect(evaluateWindow(five(92), start, null, th).verdict).toBe("NEAR_LIMIT");
  const mid = start + 3.5 * 86400;
  const planner = evaluateWindow(weekly(50), mid, null, { ...th, paceScale: 0.85 });
  expect(planner.pace).toBeCloseTo(42.5);
  expect(planner.verdict).toBe("ON_PACE");
  expect(evaluateWindow(weekly(55), mid, null, { ...th, paceScale: 0.85 }).verdict).toBe("AHEAD");
});

test("bindingWindow: hard limits first, otherwise the most urgent paced window", () => {
  const ws = (v: WindowStatus["verdict"], paced = true): WindowStatus =>
    ({ name: v, usedPct: 1, resetsAt: 1, lengthS: 1, paced, verdict: v, ...(paced ? { pace: 1 } : {}) });
  expect(bindingWindow([ws("BEHIND"), ws("EXHAUSTED", false)])?.verdict).toBe("EXHAUSTED");
  expect(bindingWindow([ws("OK", false), ws("EXPIRING"), ws("ON_PACE")])?.verdict).toBe("EXPIRING");
  expect(bindingWindow([ws("UNKNOWN")])?.verdict).toBe("UNKNOWN");
  expect(bindingWindow([])).toBeNull();
});

test("plannerMode mapping", () => {
  expect(plannerMode("EXHAUSTED")).toBe("emergency");
  expect(plannerMode("AHEAD")).toBe("strict");
  expect(plannerMode("NEAR_LIMIT")).toBe("strict");
  expect(plannerMode("ON_PACE")).toBe("normal");
  expect(plannerMode("UNKNOWN")).toBe("normal");
  expect(plannerMode("OK")).toBe("normal");
  expect(plannerMode("BEHIND")).toBe("relaxed");
  expect(plannerMode("EXPIRING")).toBe("relaxed");
});
