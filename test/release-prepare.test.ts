import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareChangelog, prepareRelease } from "../scripts/release/prepare";
import { tmpDir } from "./helpers";

const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A feature.\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n";
const desktopFiles = {
  "tauri.conf.json": '{\n  "productName": "pacer",\n  "version" : "0.1.0",\n  "bundle": { "active": true }\n}\n',
  "Cargo.toml": '# Keep this comment.\n[package]\nname = "pacer-desktop"\nversion  = "0.1.0" # app version\n\n[dependencies.example]\nversion = "9.8.7"\n',
  "Cargo.lock": '# Generated lockfile.\nversion = 4\n\n[[package]]\nname = "before"\nversion = "9.8.7"\n\n[[package]]\nname = "pacer-desktop"\nversion = "0.1.0"\ndependencies = ["before"]\n\n[[package]]\nname = "after"\nversion = "9.8.7"\n',
};

test("prepareChangelog keeps history and moves all Unreleased content into the dated release", () => {
  expect(prepareChangelog(changelog, "0.2.0", "2026-10-13")).toBe(changelog.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.2.0] - 2026-10-13"));
  expect(prepareChangelog("## [Unreleased]\n", "0.2.0", "2026-10-13")).toBe("## [Unreleased]\n\n## [0.2.0] - 2026-10-13\n");
  expect(() => prepareChangelog("# Changelog\n", "0.2.0", "2026-10-13")).toThrow("no Unreleased section");
  expect(() => prepareChangelog(changelog, "0.1.0", "2026-10-13")).toThrow("already contains");
});

function fixture(): string {
  const root = tmpDir();
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  for (const [file, text] of Object.entries(desktopFiles)) {
    writeFileSync(join(root, "desktop", "src-tauri", file), text);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0", scripts: { "plugin:build": "bun scripts/plugin.ts", "app:build": "bun scripts/app.ts" } }));
  writeFileSync(join(root, "scripts", "plugin.ts"), 'await Bun.write("built-version", (await Bun.file("package.json").json()).version);');
  writeFileSync(join(root, "scripts", "app.ts"), 'await Bun.write("app-built-version", (await Bun.file("package.json").json()).version);');
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  writeFileSync(join(root, "orca-marketplace.json"), JSON.stringify({ plugins: [{ id: "lamtuanvu.pacer", source: { kind: "git", url: "https://github.com/lamtuanvu/pacer.git", ref: "orca-plugin-v0.1.0" } }] }));
  return root;
}

test("prepareRelease updates the package and changelog before rebuilding plugin and app assets", async () => {
  const root = fixture();
  await prepareRelease(root, "0.2.0");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.2.0");
  expect(JSON.parse(readFileSync(join(root, "orca-marketplace.json"), "utf8")).plugins[0].source.ref).toBe("orca-plugin-v0.2.0");
  expect(readFileSync(join(root, "built-version"), "utf8")).toBe("0.2.0");
  expect(readFileSync(join(root, "app-built-version"), "utf8")).toBe("0.2.0");
  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## [0.2.0] - ${new Date().toISOString().slice(0, 10)}`);
});

test("prepareRelease updates only the desktop version values, preserving other packages and formatting", async () => {
  const root = fixture();
  await prepareRelease(root, "0.2.0");
  for (const [file, text] of Object.entries(desktopFiles)) {
    expect(readFileSync(join(root, "desktop", "src-tauri", file), "utf8"))
      .toBe(text.replace('"0.1.0"', '"0.2.0"'));
  }
});

for (const [file, text] of Object.entries(desktopFiles)) {
  test(`prepareRelease rejects a missing desktop version in ${file} before writing files`, async () => {
    const root = fixture();
    const path = join(root, "desktop", "src-tauri", file);
    const missingVersion = text.replace(/^.*"0\.1\.0".*\n/m, "");
    writeFileSync(path, missingVersion);
    const originalPackage = readFileSync(join(root, "package.json"), "utf8");
    await expect(prepareRelease(root, "0.2.0")).rejects.toThrow(`${file} has no`);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(originalPackage);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(changelog);
    for (const [desktopFile, original] of Object.entries(desktopFiles)) {
      expect(readFileSync(join(root, "desktop", "src-tauri", desktopFile), "utf8"))
        .toBe(desktopFile === file ? missingVersion : original);
    }
  });
}

test("prepareRelease rejects invalid, equal and older versions before writing files", async () => {
  const root = fixture();
  const original = readFileSync(join(root, "package.json"), "utf8");
  for (const version of ["0.1.0", "0.0.9", "v0.2.0", "0.2", "0.2.0-rc.1", "01.2.0"]) {
    await expect(prepareRelease(root, version)).rejects.toThrow();
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(original);
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(changelog);
  }
});
