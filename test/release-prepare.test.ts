import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareChangelog, prepareRelease } from "../scripts/release/prepare";
import { tmpDir } from "./helpers";

const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A feature.\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n";

test("prepareChangelog keeps history and moves all Unreleased content into the dated release", () => {
  expect(prepareChangelog(changelog, "0.2.0", "2026-10-13")).toBe(changelog.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.2.0] - 2026-10-13"));
  expect(prepareChangelog("## [Unreleased]\n", "0.2.0", "2026-10-13")).toBe("## [Unreleased]\n\n## [0.2.0] - 2026-10-13\n");
  expect(() => prepareChangelog("# Changelog\n", "0.2.0", "2026-10-13")).toThrow("no Unreleased section");
  expect(() => prepareChangelog(changelog, "0.1.0", "2026-10-13")).toThrow("already contains");
});

function fixture(): string {
  const root = tmpDir();
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0", scripts: { "plugin:build": "bun scripts/plugin.ts" } }));
  writeFileSync(join(root, "scripts", "plugin.ts"), 'await Bun.write("built-version", (await Bun.file("package.json").json()).version);');
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return root;
}

test("prepareRelease updates the package and changelog before rebuilding plugin assets", async () => {
  const root = fixture();
  await prepareRelease(root, "0.2.0");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.2.0");
  expect(readFileSync(join(root, "built-version"), "utf8")).toBe("0.2.0");
  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## [0.2.0] - ${new Date().toISOString().slice(0, 10)}`);
});

test("prepareRelease rejects invalid, equal and older versions before writing files", async () => {
  const root = fixture();
  const original = readFileSync(join(root, "package.json"), "utf8");
  for (const version of ["0.1.0", "0.0.9", "v0.2.0", "0.2", "0.2.0-rc.1", "01.2.0"]) {
    await expect(prepareRelease(root, version)).rejects.toThrow();
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(changelog);
  }
});
