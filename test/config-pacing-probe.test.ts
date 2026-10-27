import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";

// Minimal valid legacy strategy: planner + providers block
function minimal(yamlExtra: string = "") {
  const raw = Bun.YAML.parse(`planner: claude-code\nproviders:\n  claude-code: {}\n${yamlExtra}`);
  return validateStrategy(raw, "strategy.yaml");
}

test("pacing defaults", () => {
  const s = minimal("");
  expect(s.pacing.plannerReserveHeadroom).toBe(25);
  expect(s.pacing.plannerProbe).toBe("ask");
});

test("planner_reserve stays a separate pace multiplier", () => {
  const s = minimal("pacing: {planner_reserve: 15, planner_reserve_headroom: 40}");
  expect(s.pacing.plannerReserve).toBe(15);
  expect(s.pacing.plannerReserveHeadroom).toBe(40);
});

test("rejects out-of-range headroom", () => {
  expect(() => minimal("pacing: {planner_reserve_headroom: 100}"))
    .toThrow(/planner_reserve_headroom must be between 0 and 99/);
});

test("rejects an unknown probe mode", () => {
  expect(() => minimal("pacing: {planner_probe: sometimes}"))
    .toThrow(/planner_probe must be ask, auto or off/);
});
