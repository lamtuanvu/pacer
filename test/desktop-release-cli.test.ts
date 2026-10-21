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
