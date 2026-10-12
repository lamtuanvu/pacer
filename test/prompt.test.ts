import { expect, test } from "bun:test";
import { EXECUTOR_CONTRACT, buildPrompt } from "../src/exec/prompt";

test("full brief renders every section in order, then the contract", () => {
  const p = buildPrompt({
    goal: "Fix add()", repo: "/r", scope: "Only calc.py", context: "Bug since v2",
    constraints: "No new deps", acceptance: "python3 test_calc.py",
  }, "t-20261011-140500-abcd");
  const order = ["# Task t-20261011-140500-abcd", "## Goal\nFix add()", "## Repository\n/r", "## Scope\nOnly calc.py",
    "## Context\nBug since v2", "## Constraints\nNo new deps", "## Done when\n`python3 test_calc.py` passes."];
  let at = -1;
  for (const s of order) {
    const i = p.indexOf(s);
    expect(i).toBeGreaterThan(at);
    at = i;
  }
  expect(p.endsWith(EXECUTOR_CONTRACT)).toBe(true);
});

test("minimal brief omits empty sections and says no acceptance was given", () => {
  const p = buildPrompt({ goal: "  Tidy README  ", repo: "/r" }, "t-20261011-140500-abcd");
  expect(p).toContain("## Goal\nTidy README");
  expect(p).not.toContain("## Scope");
  expect(p).not.toContain("## Context");
  expect(p).toContain("no acceptance command was given");
});

test("the contract forbids commits and re-planning and asks for a report", () => {
  expect(EXECUTOR_CONTRACT).toContain("Do not commit, push, or change git branches");
  expect(EXECUTOR_CONTRACT).toContain("Do not redesign, re-plan or expand scope");
  expect(EXECUTOR_CONTRACT).toContain("Finish with a short report");
});

test("every executor prompt begins with exactly one role marker", () => {
  const marker = "PACER_ROLE=executor: you are a pacer executor; ignore pacer planner policy.";
  const prompt = buildPrompt({ goal: "Fix it", repo: "/r" }, "t-20261011-140500-abcd");
  expect(prompt.split("\n")[0]).toBe(marker);
  expect(prompt.split(marker)).toHaveLength(2);
});
