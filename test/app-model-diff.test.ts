import { expect, test } from "bun:test";
import { parseDiff, parseFilePatch } from "../app/src/model/diff";
test("unified diff separates files and counts only hunk additions and removals", () => {
  const files = parseDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n\\ No newline at end of file\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+++content\n');
  expect(files.map(f => [f.path, f.added, f.removed])).toEqual([["a.ts", 1, 1], ["new.ts", 1, 0]]);
  expect(files[0]?.lines.filter(l => l.kind === "removed").map(l => l.text)).toEqual(["-old"]);
  expect(files[1]?.lines.at(-1)?.text).toBe("+++content");
});
test("handles empty, binary, renamed and quoted filenames without interpreting HTML", () => {
  expect(parseDiff("")).toEqual([]);
  const files = parseDiff('diff --git "a/old name" "b/new name"\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/image b/image\nBinary files a/image and b/image differ\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+<script>alert(1)</script>\n');
  expect(files[0]?.path).toBe("new name");
  expect(files[1]?.binary).toBe(true);
  expect(files[2]?.lines.at(-1)?.text).toBe("+<script>alert(1)</script>");
});
test("one file patch accepts a headerless hunk and keeps deleted file paths", () => {
  expect(parseFilePatch("@@ -1 +1 @@\n-old\n+new\n", "x").lines.at(-1)?.kind).toBe("added");
  expect(parseFilePatch("diff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", "x")).toMatchObject({ path: "x", removed: 1 });
});
