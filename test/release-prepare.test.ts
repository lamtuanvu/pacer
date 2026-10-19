import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareChangelog, prepareRelease } from "../scripts/release/prepare";
import { tmpDir } from "./helpers";

const changelog = "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A feature.\n\n## [0.1.0] - 2026-10-01\n\n- Old.\n";
const cargo = `[package]
name = "pacer-desktop"
version = "0.1.0"

[dependencies]
other = { version = "0.1.0" }
`;
const lock = `# Generated lockfile
version = 4

[[package]]
name = "other"
version = "0.1.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "keep-me"

[[package]]
name = "pacer-desktop"
version = "0.1.0"
dependencies = ["other"]

[[package]]
name = "pacer-desktop-helper"
version = "0.1.0"
`;

test("prepareChangelog keeps history and moves all Unreleased content into the dated release", () => {
  expect(prepareChangelog(changelog, "0.2.0", "2026-10-13")).toBe(changelog.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.2.0] - 2026-10-13"));
  expect(prepareChangelog("## [Unreleased]\n", "0.2.0", "2026-10-13")).toBe("## [Unreleased]\n\n## [0.2.0] - 2026-10-13\n");
  expect(() => prepareChangelog("# Changelog\n", "0.2.0", "2026-10-13")).toThrow("no Unreleased section");
  expect(() => prepareChangelog(changelog, "0.1.0", "2026-10-13")).toThrow("already contains");
});

function fixture(): string {
  const root = tmpDir();
  mkdirSync(join(root, "scripts"));
  const desktop = join(root, "desktop", "src-tauri");
  mkdirSync(desktop, { recursive: true });
  writeFileSync(join(desktop, "Cargo.toml"), cargo);
  writeFileSync(join(desktop, "Cargo.lock"), lock);
  writeFileSync(join(desktop, "tauri.conf.json"), JSON.stringify({ productName: "pacer", version: "0.1.0" }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.1.0", scripts: { "plugin:build": "bun scripts/plugin.ts", "app:build": "bun scripts/app.ts" } }));
  writeFileSync(join(root, "scripts", "plugin.ts"), 'await Bun.write("built-version", (await Bun.file("package.json").json()).version);');
  writeFileSync(join(root, "scripts", "app.ts"), 'await Bun.write("app-built-version", (await Bun.file("package.json").json()).version);');
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  writeFileSync(join(root, "orca-marketplace.json"), JSON.stringify({ plugins: [{ id: "lamtuanvu.pacer", source: { kind: "git", url: "https://github.com/lamtuanvu/pacer.git", ref: "orca-plugin-v0.1.0" } }] }));
  return root;
}

test("prepareRelease updates package, desktop and changelog before rebuilding plugin and app assets", async () => {
  const root = fixture();
  await prepareRelease(root, "0.2.0");
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe("0.2.0");
  const desktop = join(root, "desktop", "src-tauri");
  expect(JSON.parse(readFileSync(join(desktop, "tauri.conf.json"), "utf8"))).toEqual({ productName: "pacer", version: "0.2.0" });
  expect(readFileSync(join(desktop, "Cargo.toml"), "utf8")).toBe(cargo.replace('version = "0.1.0"', 'version = "0.2.0"'));
  expect(readFileSync(join(desktop, "Cargo.lock"), "utf8")).toBe(lock.replace('name = "pacer-desktop"\nversion = "0.1.0"', 'name = "pacer-desktop"\nversion = "0.2.0"'));
  expect(JSON.parse(readFileSync(join(root, "orca-marketplace.json"), "utf8")).plugins[0].source.ref).toBe("orca-plugin-v0.2.0");
  expect(readFileSync(join(root, "built-version"), "utf8")).toBe("0.2.0");
  expect(readFileSync(join(root, "app-built-version"), "utf8")).toBe("0.2.0");
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
