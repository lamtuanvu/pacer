import { expect, test } from "bun:test";
import { fullTaskTitle, taskTitle } from "../src/core/short-title";
import { displayTitle } from "../src/view-model/titles";
import { parseDelegateBrief } from "../src/tasks/api";

for (const [goal, expected] of [
  ["# Strict design-fidelity audit (re…", "Strict design-fidelity audit"],
  ["Settings fixes in the pacer app (boards", "Settings fixes in the pacer app"],
  ["- **Fix** [the queue](https://example.com) with `retry`. Run checks", "Fix the queue with retry"],
  ["1. Fix queue\nMore details", "Fix queue"],
  ["_Fix_ needs_input handling", "Fix needs_input handling"],
  ["Fix queue (including retries). Run checks", "Fix queue (including retries)"],
]) test(`display title: ${goal}`, () => {
  expect(fullTaskTitle({ brief: { goal } })).toBe(expected);
  expect(taskTitle({ brief: { goal } })).toBe(expected);
  expect(displayTitle({ title: goal, goal })).toBe(expected);
});
test("derived labels clip at words without leaving brackets open", () => {
  const goal = "Repair the settings page and preserve the selected session (including every saved preference and scroll position)";
  const title = fullTaskTitle({ brief: { goal } });
  expect(title).toBe("Repair the settings page and preserve the selected session…");
  expect(title.length).toBeLessThanOrEqual(80);
});
test("explicit JSON brief title is accepted", () => {
  expect(parseDelegateBrief({ title: "Custom task", goal: "# Raw goal", repo: "/repo" }, "/repo").title).toBe("Custom task");
  expect(fullTaskTitle({ title: "Custom task", brief: { goal: "# Raw goal" } })).toBe("Custom task");
});

test("compact service labels never leave a bracket group open", () => {
  const goal = "Update task queue handling (including retry state and timeout recovery)";
  expect(taskTitle({ title: fullTaskTitle({ brief: { goal } }), brief: { goal } })).toBe("Update task queue handling…");
  expect(displayTitle({ title: "# Strict design-fidelity audit (re…", goal: "# Strict design-fidelity audit (review changes). Run checks" })).toBe("Strict design-fidelity audit (review changes)");
  expect(fullTaskTitle({ brief: { goal: "> # **Fix** [the queue][queue]" } })).toBe("Fix the queue");
});

test("nested link destinations disappear and explicit short titles remain", () => {
  expect(fullTaskTitle({ brief: { goal: "# [Fix](https://example.com/thing(foo)) the queue" } })).toBe("Fix the queue");
  expect(displayTitle({ title: "Fix", goal: "Fix the queue" })).toBe("Fix");
});

test("stored legacy raw prefixes are repaired on the service read path", () => {
  const goal = "# Strict design-fidelity audit (review all recent task changes and verify design alignment). Then test";
  const title = "# Strict design-fidelity audit (review all recent task…";
  expect(fullTaskTitle({ title, brief: { goal } })).toBe("Strict design-fidelity audit…");
  expect(taskTitle({ title, brief: { goal } })).toBe("Strict design-fidelity audit…");
  expect(fullTaskTitle({ title: "Strict design-fidelity audit (review all recent task…", brief: { goal } })).toBe("Strict design-fidelity audit…");
});
