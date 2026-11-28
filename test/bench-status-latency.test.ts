import { expect, test } from "bun:test";
import { guard, nearestRank, RUST_DOOR_REQUIRED } from "../scripts/bench/status-latency";
import type { Session } from "../scripts/live/core";

// The bench percentile is the nearest-rank estimate (summaries.round(ceil)). Bounded here so a
// percentile of a tiny sample stays a real observed value, never interpolated or clamped to 0.

test("nearestRank: odd sample reports real observed values", () => {
  const sorted = [1, 2, 3, 4, 5];
  expect(nearestRank(sorted, 50)).toBe(3);
  expect(nearestRank(sorted, 95)).toBe(5);
});

test("nearestRank: single sample reports that sample for every percentile", () => {
  expect(nearestRank([1], 50)).toBe(1);
  expect(nearestRank([1], 95)).toBe(1);
});

test("nearestRank: rejects an empty sample", () => {
  expect(() => nearestRank([], 50)).toThrow("percentile of an empty sample");
});

test("guard refuses a non-rust front door sandbox", () => {
  const session = { frontDoor: undefined } as Session;
  expect(() => guard(session)).toThrow(RUST_DOOR_REQUIRED);
  expect(() => guard(session)).toThrow("status bench needs a --front-door rust sandbox");
});