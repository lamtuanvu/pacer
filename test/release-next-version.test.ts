import { expect, test } from "bun:test";
import { applyBump, bumpFor, nextVersion, unreleasedNotes } from "../scripts/release/next-version";

const changelog = (notes: string) => `# Changelog\n\n## [Unreleased]\n${notes}\n## [0.4.0] - 2026-10-20\n\n### Added\n\n- Old.\n`;

test("the largest change since the last tag picks the bump", () => {
  expect(bumpFor(["docs: tidy", "fix(app): close a leak"], "0.4.0")).toBe("patch");
  expect(bumpFor(["fix: a", "feat(desktop): b", "perf: c"], "0.4.0")).toBe("minor");
  expect(bumpFor(["feat: a", "feat!: drop the plugin"], "1.2.0")).toBe("major");
  expect(bumpFor(["chore: release 0.4.0", "test: x", "ci(release): y", "docs: z"], "0.4.0")).toBeNull();
  expect(bumpFor(["Merge branch main", "not conventional"], "0.4.0")).toBeNull();
});

test("during 0.x a breaking change is a minor bump", () => {
  expect(bumpFor(["refactor(api)!: rename an op"], "0.4.0")).toBe("minor");
  expect(nextVersion({ current: "0.4.0", subjects: ["feat!: remove x"], requested: "auto", changelog: changelog("\n### Removed\n\n- X.\n") }).version).toBe("0.5.0");
});

test("bumps reset the lower parts", () => {
  expect(applyBump("0.4.7", "patch")).toBe("0.4.8");
  expect(applyBump("0.4.7", "minor")).toBe("0.5.0");
  expect(applyBump("0.4.7", "major")).toBe("1.0.0");
  expect(() => applyBump("0.5.0-rc.1", "patch")).toThrow("MAJOR.MINOR.PATCH");
});

test("an explicit bump overrides the commits, but never an empty CHANGELOG", () => {
  expect(nextVersion({ current: "0.4.0", subjects: ["docs: only docs"], requested: "patch", changelog: changelog("\n### Fixed\n\n- A.\n") })).toEqual({ version: "0.4.1", bump: "patch" });
  expect(() => nextVersion({ current: "0.4.0", subjects: ["docs: only docs"], requested: "auto", changelog: changelog("\n### Fixed\n\n- A.\n") })).toThrow("pick a bump explicitly");
  expect(() => nextVersion({ current: "0.4.0", subjects: ["feat: a"], requested: "minor", changelog: changelog("\n") })).toThrow("Unreleased is empty");
});

test("Unreleased notes stop at the next release heading or the end", () => {
  expect(unreleasedNotes(changelog("\n### Fixed\n\n- A.\n"))).toBe("### Fixed\n\n- A.");
  expect(unreleasedNotes("## [Unreleased]\n\n- Only.\n")).toBe("- Only.");
  expect(() => unreleasedNotes("# Changelog\n")).toThrow("no Unreleased");
});
