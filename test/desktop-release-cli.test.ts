import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { prepareDesktopManifest } from "../scripts/release/desktop-release";
test("immutable release metadata comes from exact changelog heading and commit date", async () => {
  const root = tmpDir(), out = join(root, "out"); mkdirSync(out);
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\nignore\n\n## [1.2.3] - 2026-10-19\n\nChanged desktop.\n\n## [1.2.2]\nold\n");
  await prepareDesktopManifest(root, out, "1.2.3", "2026-10-19T00:00:00Z");
  const before = readFileSync(join(out, "desktop-release-1.2.3.json"), "utf8");
  expect(JSON.parse(before)).toEqual({ schema: 1, version: "1.2.3", notes: "Changed desktop.", pub_date: "2026-10-19T00:00:00Z" });
  await prepareDesktopManifest(root, out, "1.2.3", "2026-10-19T00:00:00Z");
  expect(readFileSync(join(out, "desktop-release-1.2.3.json"), "utf8")).toBe(before);
  await expect(prepareDesktopManifest(root, out, "1.2.3", "2026-10-20T00:00:00Z")).rejects.toThrow("immutable");
  await expect(prepareDesktopManifest(root, out, "1.2.4", "2026-10-19T00:00:00Z")).rejects.toThrow("notes");
});

test("long release notes are cut at an entry and link to the full notes, within the feed limit", async () => {
  const { DESKTOP_NOTES_MAX, desktopNotes } = await import("../scripts/release/desktop-release");
  expect(desktopNotes("### Fixed\n\n- Short.", "1.2.3")).toBe("### Fixed\n\n- Short.");
  const entry = (i: number) => `- Entry ${i}: ${"x".repeat(400)}`;
  const long = ["### Added", "", ...Array.from({ length: 60 }, (_, i) => entry(i)), "", "### Fixed", "", ...Array.from({ length: 60 }, (_, i) => entry(100 + i))].join("\n");
  const cut = desktopNotes(long, "1.2.3");
  expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(DESKTOP_NOTES_MAX);
  expect(cut.startsWith("### Added\n\n- Entry 0: ")).toBe(true);
  expect(cut.endsWith("The full release notes are at https://github.com/lamtuanvu/pacer/releases/tag/v1.2.3.")).toBe(true);
  // Every kept entry is whole: the last one before the link has its full text.
  const lastEntry = cut.split("\n\nThe full release notes")[0]!.split("\n").at(-1)!;
  expect(lastEntry).toMatch(/^- Entry \d+: x{400}$/);
  // The real 0.15.0 notes are twice the limit; through the manifest they now fit.
  const root = tmpDir(), out = join(root, "out"); mkdirSync(out);
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## [1.2.3] - 2026-11-16\n\n${long}\n\n## [1.2.2]\nold\n`);
  await prepareDesktopManifest(root, out, "1.2.3", "2026-11-16T00:00:00Z");
  expect(Buffer.byteLength(JSON.parse(readFileSync(join(out, "desktop-release-1.2.3.json"), "utf8")).notes, "utf8")).toBeLessThanOrEqual(DESKTOP_NOTES_MAX);
});
