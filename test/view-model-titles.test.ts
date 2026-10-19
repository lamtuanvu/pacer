import { expect, test } from "bun:test";
import { displayTitle } from "../src/view-model/titles";

test("layout titles prefer the full API text without clipping commands, paths or punctuation", () => {
  const fullTitle = "Repair the queue " + "for all existing workers ".repeat(12) + "(keep src/core/tasks.ts and `bun run test`)";
  expect(displayTitle({ fullTitle, title: "Repair the queue…", goal: "capped legacy goal" })).toBe(fullTitle);
  expect(displayTitle({ title: fullTitle })).toBe(fullTitle);
  expect(displayTitle({ goal: fullTitle })).toBe(fullTitle);
  expect(displayTitle({ fullTitle: " ", title: "Fallback" })).toBe("Fallback");
  expect(displayTitle({})).toBe("Task");
});
