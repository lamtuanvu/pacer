import { expect, test } from "bun:test";
import { displayTitle, taskHeading } from "../src/view-model/titles";

test("layout titles prefer the full API text without clipping commands, paths or punctuation", () => {
  const fullTitle = "Repair the queue " + "for all existing workers ".repeat(12) + "(keep src/core/tasks.ts and `bun run test`)";
  expect(displayTitle({ fullTitle, title: "Repair the queue…", goal: "capped legacy goal" })).toBe(fullTitle);
  expect(displayTitle({ title: fullTitle })).toBe(fullTitle);
  expect(displayTitle({ fullTitle, goal: fullTitle })).toBe(fullTitle);
  expect(displayTitle({ goal: fullTitle })).toBe("Repair the queue for all existing workers for all existing workers for all…");
  expect(displayTitle({ fullTitle: " ", title: "Fallback" })).toBe("Fallback");
  expect(displayTitle({})).toBe("Task");
});

test("taskHeading shortens single-paragraph briefs and handles legacy headings", () => {
  const brief = "Fix the retry bug. " + "Keep existing routes and validate the deployment constraints. ".repeat(12);
  expect(brief.length).toBeGreaterThan(400);
  expect(taskHeading(brief)).toBe("Fix the retry bug");
  expect(taskHeading("\n# Fix the retry bug\nFull brief constraints")).toBe("Fix the retry bug");
  expect(taskHeading(" ")).toBe("Task");
  expect(taskHeading("Update " + "the worker configuration ".repeat(30)).length).toBeLessThanOrEqual(60);
});
