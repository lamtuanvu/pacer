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

test("cut desktop notes stay whole at section boundaries and with multibyte text", async () => {
  const { DESKTOP_NOTES_MAX, desktopNotes } = await import("../scripts/release/desktop-release");
  const wide = (i: number) => `- Mục ${i}: ${"漢🎉é".repeat(120)}`;
  const notes = ["### Added", "", ...Array.from({ length: 40 }, (_, i) => wide(i)), "", "### Fixed", "", ...Array.from({ length: 40 }, (_, i) => wide(100 + i))].join("\n");
  const cut = desktopNotes(notes, "1.2.3");
  expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(DESKTOP_NOTES_MAX);
  expect(cut).not.toMatch(/\n#{1,6} [^\n]*\n\nThe full release notes/);
  expect(cut).not.toContain("\n\n\n");
  expect(cut.split("\n\nThe full release notes")[0]!.split("\n").at(-1)).toMatch(/^- Mục \d+: (?:漢🎉é){120}$/);
  // One entry larger than the whole budget leaves only the link.
  expect(desktopNotes(`### Fixed\n\n- ${"x".repeat(DESKTOP_NOTES_MAX)}`, "1.2.3")).toBe("The full release notes are at https://github.com/lamtuanvu/pacer/releases/tag/v1.2.3.");
});


test("nightly manifest uses the provided notes and needs no CHANGELOG section", async () => {
  const root = tmpDir(), out = join(root, "out"); mkdirSync(out);
  writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [0.15.1] - 2026-11-10\n\nold\n");
  const version = "0.16.0-nightly.202611171700";
  await prepareDesktopManifest(root, out, version, "2026-11-17T17:00:00Z", "## pacer 0.16.0-nightly.202611171700\n\n- feat: a\n");
  expect(JSON.parse(readFileSync(join(out, `desktop-release-${version}.json`), "utf8"))).toEqual({ schema: 1, version, notes: "## pacer 0.16.0-nightly.202611171700\n\n- feat: a", pub_date: "2026-11-17T17:00:00Z" });
  // Provided notes are cut to the feed limit like CHANGELOG notes.
  const { DESKTOP_NOTES_MAX } = await import("../scripts/release/desktop-release");
  const long = `## pacer 0.16.1-nightly.202611171700\n\n${Array.from({ length: 2000 }, (_, i) => `- fix: entry ${i} ${"x".repeat(40)}`).join("\n")}`;
  await prepareDesktopManifest(root, out, "0.16.1-nightly.202611171700", "2026-11-17T17:00:00Z", long);
  expect(Buffer.byteLength(JSON.parse(readFileSync(join(out, "desktop-release-0.16.1-nightly.202611171700.json"), "utf8")).notes, "utf8")).toBeLessThanOrEqual(DESKTOP_NOTES_MAX);
  // Without notes a nightly still needs a CHANGELOG section, and other prereleases stay rejected.
  await expect(prepareDesktopManifest(root, out, "0.16.2-nightly.202611171700", "2026-11-17T17:00:00Z")).rejects.toThrow("notes");
  await expect(prepareDesktopManifest(root, out, "0.16.0-rc.1", "2026-11-17T17:00:00Z", "- notes")).rejects.toThrow();
});

test("prepare CLI reads --notes-file and rejects malformed arguments", () => {
  const script = join(import.meta.dir, "..", "scripts", "release", "desktop-release.ts");
  const dir = tmpDir(), notes = join(dir, "release-notes.md"), version = "0.16.0-nightly.202611171700";
  writeFileSync(notes, "## pacer 0.16.0-nightly.202611171700\n\n- fix: b\n");
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  // HEAD's commit date is read from the repository the script lives in.
  const ok = run("prepare", dir, version, "--notes-file", notes);
  expect(ok.stderr.toString()).toBe("");
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, `desktop-release-${version}.json`), "utf8")).notes).toBe("## pacer 0.16.0-nightly.202611171700\n\n- fix: b");
  expect(run("prepare", dir, version, "--notes-file").exitCode).toBe(1);
  expect(run("prepare", dir, version, "--other", notes).exitCode).toBe(1);
  expect(run("validate", dir, version, "--notes-file", notes).exitCode).toBe(1);
  expect(run("prepare", dir, version, "--notes-file", join(dir, "missing.md")).exitCode).toBe(1);
});
