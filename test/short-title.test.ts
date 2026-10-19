import { expect, spyOn, test } from "bun:test";
import { fullTaskTitle, shortTitle, taskTitle } from "../src/core/short-title";

const goals = [
  ["src/api/read-model/tasks.ts: add a title field", "Add a title field"],
  ["`foo()`: crashes on null", "Crashes on null"],
  ["... ; : ** fix the queue. Run tests", "Fix the queue"],
  ["File.txt", "File.txt"],
  ["/repo/src/file.ts", "File"],
  ["C:\\repo\\file.ts", "File"],
  ["# Goal\nImplement the tray badge\n\nDetails", "Implement the tray badge"],
  ["## Task: implement X", "Implement X"],
  ["# Summary\n## Context\n\n- fix the queue", "Fix the queue"],
  ["# Goal\nsrc/core/tasks.ts\nImplement the tray badge", "Implement the tray badge"],
  ["Fix login and/or signup flow on TCP/IP", "Fix login and/or signup flow on TCP/IP"],
  ["Fix https://example.com/a/b and `foo()` crashes", "Fix"],
  ["Fix src/api/read-model/tasks.ts and ./test.ts crashes", "Fix"],
  ["Fix src/file.ts and test.txt crashes", "Fix"],
  // Bare file names are words, not paths.
  ["Fix add() in calc.py so python3 test_calc.py prints ok", "Fix add() in calc.py so python3 test_calc.py prints ok"],
  ["Rename config.yaml keys and update README.md", "Rename config.yaml keys and update README.md"],
  // A real path mid-sentence ends the title instead of leaving a hole, without a dangling preposition.
  ["Update the retry limit in src/core/tasks.ts so slow runners finish", "Update the retry limit"],
  ["Load settings from ~/.config/pacer.yaml before start", "Load settings"],
  ["Read ./fixtures/a.json and compare", "Read"],
  ["Ignore .env when copying files", "Ignore .env when copying files"],
  ["~/notes/todo.md: tidy the backlog", "Tidy the backlog"],
  ["", "Task"],
  ["`foo()`", "Task"],
] as const;
for (const [goal, title] of goals) test(`short title: ${JSON.stringify(goal)}`, () => {
  expect(shortTitle(goal)).toBe(title);
});

test("long goals are capped before parsing and derive in under 20 ms", () => {
  const goal = "x".repeat(50_000);
  const start = performance.now();
  const title = shortTitle(goal);
  expect(performance.now() - start).toBeLessThan(20);
  expect(title).toBe("X" + "x".repeat(58) + "…");
  expect(shortTitle(" ".repeat(400) + "Ignore beyond cap")).toBe("Task");
});

for (const title of ["🚀".repeat(61), "Implement " + "🚀".repeat(55), "Fix " + "queue ".repeat(20)]) {
  test(`titles truncate by code point at a word boundary: ${title.slice(0, 10)}`, () => {
    const derived = shortTitle(title);
    expect(Array.from(derived).length).toBeLessThanOrEqual(60);
    expect(derived.endsWith("…")).toBe(true);
    expect(derived).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(taskTitle({title, brief:{goal:"unused"}})).toBe(derived);
  });
}
test("legacy titles are memoized by task id with bounded storage", () => {
  const parsing = spyOn(String.prototype, "slice");
  try {
    const legacy = {id:"cached-legacy", brief:{goal:"Fix the queue"}};
    expect(taskTitle(legacy)).toBe("Fix the queue");
    const calls = parsing.mock.calls.length;
    expect(taskTitle({...legacy,brief:{...legacy.brief}})).toBe("Fix the queue");
    expect(parsing.mock.calls.length).toBe(calls);
    for (let i=0; i<1100; i++) taskTitle({id:`cache-fill-${i}`,brief:{goal:"Another task"}});
    const afterFill = parsing.mock.calls.length;
    expect(taskTitle(legacy)).toBe("Fix the queue");
    expect(parsing.mock.calls.length).toBeGreaterThan(afterFill);
    expect(taskTitle({...legacy,brief:{goal:"Updated goal"}})).toBe("Updated goal");
  } finally { parsing.mockRestore(); }
});

test("layout titles preserve full goals and explicit titles while compact fallbacks stay bounded", () => {
  const goal = "Repair the review queue and preserve the complete title (no code edits are omitted). Then verify `bun run test` in src/core/tasks.ts";
  for (const title of [undefined, shortTitle(goal)]) {
    expect(fullTaskTitle({ title, brief: { goal } })).toBe(goal);
  }
  const title = "A custom title " + "with complete words ".repeat(8) + "(including this closing bracket)";
  expect(fullTaskTitle({ title, brief: { goal } })).toBe(title);
  expect(fullTaskTitle({ title: "Investigate…", brief: { goal } })).toBe("Investigate…");
  expect(Array.from(taskTitle({ brief: { goal } })).length).toBeLessThanOrEqual(60);
});
