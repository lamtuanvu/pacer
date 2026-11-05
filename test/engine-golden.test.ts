import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { engineGoldens } from "./engine-golden";

test("current TypeScript engine matches committed goldens", () => {
  expect(engineGoldens()).toEqual(JSON.parse(readFileSync("test/fixtures/engine/goldens.json", "utf8")));
});

test("pace goldens cover fractional offsets, calendar boundaries, and DST in every zone", () => {
  const pace = engineGoldens().pace;
  const zones = [
    "UTC", "America/Los_Angeles", "Europe/London", "Asia/Kolkata",
    "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Chatham",
    "America/St_Johns", "Australia/Sydney", "Pacific/Kiritimati",
  ];
  for (const zone of zones) {
    const cases = pace.filter(item => item.zone === zone);
    for (const name of ["fractional-offset", "day-boundary", "week-boundary", "window-boundary"]) {
      expect(cases.some(item => item.name === name)).toBe(true);
    }
    const transitions = cases.filter(item => item.name.startsWith("dst-transition"));
    expect(transitions).toHaveLength(["UTC", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Kiritimati"].includes(zone) ? 0 : 2);
  }
  const kolkata = pace.find(item => item.zone === "Asia/Kolkata" && item.name === "fractional-offset");
  expect(kolkata?.output.pacePct).toBe(50);
  expect(kolkata?.output.activeHoursLeft).toBe(0.5);
});

test("eligibility goldens cover spending, conflicts, unavailable and unmetered contracts", () => {
  const names = engineGoldens().eligibility.map(item => item.name);
  for (const name of ["unavailable", "conflict", "spending-observed", "spending-clear", "reactive", "unmetered", "budget-not-required"]) {
    expect(names).toContain(name);
  }
});

test("rank goldens cover kind routing, exclusions, planner include and conversation fallback", () => {
  const names = engineGoldens().rank.map(item => item.name);
  for (const name of ["kind-review", "exclusions", "planner-excluded", "planner-included", "expiring"]) {
    expect(names).toContain(name);
  }
  expect(engineGoldens().conversation.map(item => item.name)).toEqual(["append-planner", "already-ranked"]);
  expect(engineGoldens().mode).toHaveLength(8);
});
