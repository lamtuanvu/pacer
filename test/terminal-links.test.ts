import { describe, expect, test } from "bun:test";
import { classifyTerminalLink, findTerminalLinks, shouldActivateTerminalLink, findWrappedFileLinks } from "../app/src/term/links";

describe("terminal link destinations", () => {
  test("opens only HTTP web URLs from plain output", () => {
    expect(classifyTerminalLink("https://example.com/docs?q=1", false)).toEqual({ kind: "web", url: "https://example.com/docs?q=1" });
    expect(classifyTerminalLink("javascript:alert(1)", false)).toBeNull();
  });

  test("uses an explicit OSC 8 target instead of its visible label", () => {
    expect(classifyTerminalLink("file:///repo/src/main.ts", true)).toEqual({ kind: "file", reference: "/repo/src/main.ts" });
    expect(classifyTerminalLink("file://remote/repo/a.ts", true)).toBeNull();
    expect(classifyTerminalLink("mailto:user@example.com", true)).toBeNull();
  });

  test("recognizes source paths and locations", () => {
    expect(classifyTerminalLink("src/main.ts:42:7", false)).toEqual({ kind: "file", reference: "src/main.ts", line: 42, column: 7 });
    expect(classifyTerminalLink("README.md", false)).toEqual({ kind: "file", reference: "README.md" });
    expect(classifyTerminalLink("./docs/my page.md:8", false)).toEqual({ kind: "file", reference: "./docs/my page.md", line: 8 });
    expect(classifyTerminalLink("version 1.2", false)).toBeNull();
  });

  test("trims sentence punctuation without deleting path punctuation", () => {
    expect(classifyTerminalLink("src/a.ts:2).", false)).toEqual({ kind: "file", reference: "src/a.ts", line: 2 });
    expect(classifyTerminalLink("https://example.com/a(b)", false)).toEqual({ kind: "web", url: "https://example.com/a(b)" });
  });
});

test("finds links in terminal prose without swallowing adjacent punctuation", () => {
  expect(findTerminalLinks("See src/main.ts:42, then https://example.com/a(b)."))
    .toEqual([
      { start: 4, end: 18, target: { kind: "file", reference: "src/main.ts", line: 42 } },
      { start: 25, end: 49, target: { kind: "web", url: "https://example.com/a(b)" } },
    ]);
});

test("quoted paths preserve spaces", () => {
  expect(findTerminalLinks("Open `./docs/my page.md:8`"))
    .toEqual([{ start: 5, end: 26, target: { kind: "file", reference: "./docs/my page.md", line: 8 } }]);
});

test("recognizes root-level filenames with line numbers in terminal output", () => {
  expect(findTerminalLinks("  README.md:1 index.html:2"))
    .toEqual([
      { start: 2, end: 13, target: { kind: "file", reference: "README.md", line: 1 } },
      { start: 14, end: 26, target: { kind: "file", reference: "index.html", line: 2 } },
    ]);
});

test("requires a modifier only while the user controls the terminal", () => {
  expect(shouldActivateTerminalLink(true, { metaKey: false, ctrlKey: false })).toBe(false);
  expect(shouldActivateTerminalLink(true, { metaKey: true, ctrlKey: false })).toBe(true);
  expect(shouldActivateTerminalLink(false, { metaKey: false, ctrlKey: false })).toBe(true);
});

test("maps a file reference wrapped across terminal rows to its full link range", () => {
  expect(findWrappedFileLinks([
    { text: "See src/very/", wrapped: false },
    { text: "long-file.ts:12", wrapped: true },
  ], 1)).toEqual([{ start: { x: 5, y: 1 }, end: { x: 15, y: 2 }, target: { kind: "file", reference: "src/very/long-file.ts", line: 12 } }]);
});

test("maps links after wide Unicode cells to terminal columns", () => {
  expect(findWrappedFileLinks([{ text: "界 src/main.ts", wrapped: false, cells: [1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] }], 0))
    .toEqual([{ start: { x: 4, y: 1 }, end: { x: 14, y: 1 }, target: { kind: "file", reference: "src/main.ts" } }]);
});

test("includes both cells when a file link ends in a wide character", () => {
  expect(findWrappedFileLinks([{ text: "src/界", wrapped: false, cells: [1, 2, 3, 4, 5], endCells: [1, 2, 3, 4, 6] }], 0))
    .toEqual([{ start: { x: 1, y: 1 }, end: { x: 6, y: 1 }, target: { kind: "file", reference: "src/界" } }]);
});
