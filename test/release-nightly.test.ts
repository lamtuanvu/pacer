import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_NIGHTLY_FEED_FILE } from "../scripts/release/cli-feed";
import { DESKTOP_FEED_FILE } from "../scripts/release/desktop-feed";
import { NIGHTLY_FEED_FILES, NIGHTLY_STAMP_FILES, isNightlyVersion, nightlyNotes, nightlyVersion, prunable, pruneNightlies, releaseChannel, stampNightly, type NightlyPruneClient } from "../scripts/release/nightly";
import { compareVersions } from "../src/update/version";
import { tmpDir } from "./helpers";

const NIGHTLY = "0.16.0-nightly.202611171700";
const SCRIPT = resolve(import.meta.dir, "..", "scripts", "release", "nightly.ts");

test("nightly version is the next minor with a UTC minute stamp", () => {
  expect(nightlyVersion("0.15.1", new Date("2026-11-17T17:00:30Z"))).toBe(NIGHTLY);
  expect(nightlyVersion("1.2.9", new Date("2027-01-02T03:04:00Z"))).toBe("1.3.0-nightly.202701020304");
  expect(() => nightlyVersion("0.16.0-rc.1", new Date("2026-11-17T17:00:00Z"))).toThrow("X.Y.Z");
});

test("nightly sorts above the current stable and below the next minor", () => {
  const v = nightlyVersion("0.15.1", new Date("2026-11-17T17:00:00Z"));
  expect(compareVersions(v, "0.15.1")).toBe(1);
  expect(compareVersions(v, "0.15.2")).toBe(1);
  expect(compareVersions(v, "0.16.0")).toBe(-1);
  expect(compareVersions(v, nightlyVersion("0.15.1", new Date("2026-11-17T17:01:00Z")))).toBe(-1);
});

test("channel classification", () => {
  expect(releaseChannel("0.15.1")).toBe("stable");
  expect(releaseChannel(NIGHTLY)).toBe("nightly");
  expect(releaseChannel("0.16.0-rc.1")).toBe("prerelease");
  expect(releaseChannel("0.16.0-nightly.1")).toBe("prerelease");
  expect(isNightlyVersion(NIGHTLY)).toBe(true);
  expect(isNightlyVersion("0.16.0-nightly.002611171700")).toBe(false);
  expect(() => releaseChannel("v0.15.1")).toThrow();
});

test("notes list commit subjects and fit the desktop limit", () => {
  const notes = nightlyNotes(["feat: a", "fix: b"], NIGHTLY);
  expect(notes).toContain(`## pacer ${NIGHTLY}`);
  expect(notes).toContain("- feat: a");
  expect(notes).toContain("- fix: b");
  const long = nightlyNotes(Array(5000).fill("x".repeat(80)), NIGHTLY);
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(32768);
  expect(long).toContain(`https://github.com/lamtuanvu/pacer/releases/tag/v${NIGHTLY}`);
});

test("stamp files are exactly the version files", () => {
  expect([...NIGHTLY_STAMP_FILES].sort()).toEqual(["app/assets.generated.json", "desktop/src-tauri/Cargo.lock", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/tauri.conf.json", "package.json"]);
});

const cargo = '[package]\nname = "pacer-desktop"\nversion = "0.15.1"\n\n[dependencies]\nother = { version = "0.1.0" }\n';
const lock = '# Generated lockfile\nversion = 4\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "pacer-desktop"\nversion = "0.15.1"\ndependencies = ["other"]\n';
const tauriConf = '{\n  "productName": "pacer",\n  "version": "0.15.1",\n  "bundle": { "targets": ["app"] }\n}\n';
const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.15.1] - 2026-11-10\n\n- Old.\n";

function fixture(): string {
  const root = tmpDir();
  const desktop = join(root, "desktop", "src-tauri");
  mkdirSync(desktop, { recursive: true });
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(desktop, "Cargo.toml"), cargo);
  writeFileSync(join(desktop, "Cargo.lock"), lock);
  writeFileSync(join(desktop, "tauri.conf.json"), tauriConf);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.15.1", scripts: { "app:build": "bun scripts/app.ts" } }, null, 2)}\n`);
  // Stub app:build: regenerate the embedded APP_VERSION from package.json, as the real build does.
  writeFileSync(join(root, "scripts", "app.ts"), 'const { version } = await Bun.file("package.json").json();\nawait Bun.write("app/assets.generated.json", `${JSON.stringify({ version, files: [] }, null, 2)}\\n`);\n');
  writeFileSync(join(root, "app", "assets.generated.json"), `${JSON.stringify({ version: "0.15.1", files: [] }, null, 2)}\n`);
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function cli(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("stampNightly writes the version into every stamp file and leaves CHANGELOG untouched", async () => {
  const root = fixture();
  await stampNightly(root, NIGHTLY);
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version).toBe(NIGHTLY);
  expect(readFileSync(join(root, "package.json"), "utf8").endsWith("}\n")).toBe(true);
  const desktop = join(root, "desktop", "src-tauri");
  expect(readFileSync(join(desktop, "tauri.conf.json"), "utf8")).toBe(tauriConf.replace('"version": "0.15.1"', `"version": "${NIGHTLY}"`));
  expect(readFileSync(join(desktop, "Cargo.toml"), "utf8")).toBe(cargo.replace('version = "0.15.1"', `version = "${NIGHTLY}"`));
  expect(readFileSync(join(desktop, "Cargo.lock"), "utf8")).toBe(lock.replace('name = "pacer-desktop"\nversion = "0.15.1"', `name = "pacer-desktop"\nversion = "${NIGHTLY}"`));
  const manifestJson = JSON.parse(readFileSync(join(root, "app", "assets.generated.json"), "utf8"));
  expect(manifestJson.version).toBe(NIGHTLY);
  expect(readFileSync(join(root, "app", "assets.generated.json"), "utf8").endsWith("}\n")).toBe(true);
  expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(changelog);
});

test("stampNightly rejects stable and other prerelease versions before writing", async () => {
  const root = fixture();
  const pkg = readFileSync(join(root, "package.json"), "utf8");
  for (const version of ["0.16.0", "0.16.0-rc.1", "0.16.0-nightly.1"]) {
    await expect(stampNightly(root, version)).rejects.toThrow("nightly");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(pkg);
  }
});

test("CLI version, classify, notes and check-diff work against a repository", () => {
  const root = fixture();
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "commit", "-qm", "chore: initial");
  git(root, "tag", "v0.15.1");
  git(root, "commit", "--allow-empty", "-qm", "feat: newer work");
  git(root, "tag", "v0.17.0-rc.1");
  git(root, "commit", "--allow-empty", "-qm", "fix: a bug");

  // The latest stable tag ignores prerelease tags.
  const version = cli(root, "version", "--at", "2026-11-17T17:00:00Z");
  expect(version).toMatchObject({ code: 0, stdout: `${NIGHTLY}\n` });

  expect(cli(root, "classify", NIGHTLY).stdout).toBe("nightly\n");
  expect(cli(root, "classify", "0.15.1").stdout).toBe("stable\n");
  expect(cli(root, "classify", "0.16.0-rc.1").stdout).toBe("prerelease\n");
  expect(cli(root, "classify", "v1").code).toBe(1);

  const notes = cli(root, "notes", NIGHTLY, "v0.15.1", "HEAD");
  expect(notes.code).toBe(0);
  expect(notes.stdout).toContain("- feat: newer work");
  expect(notes.stdout).toContain("- fix: a bug");
  expect(notes.stdout).not.toContain("chore: initial");

  // A stamp commit that touches only the version files passes; anything else fails.
  const parent = git(root, "rev-parse", "HEAD");
  const stamp = cli(root, "stamp", NIGHTLY);
  expect(stamp.code).toBe(0);
  git(root, "add", "-A");
  git(root, "commit", "-qm", `chore: nightly ${NIGHTLY}`);
  expect(cli(root, "check-diff", parent, "HEAD").code).toBe(0);
  writeFileSync(join(root, "README.md"), "changed\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "docs: sneak in");
  const bad = cli(root, "check-diff", parent, "HEAD");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("README.md");

  // Rename detection would list only the destination; check-diff reports both paths of a moved file.
  const before = git(root, "rev-parse", "HEAD");
  git(root, "mv", "README.md", "MOVED.md");
  git(root, "commit", "-qm", "docs: move");
  const moved = cli(root, "check-diff", before, "HEAD");
  expect(moved.code).toBe(1);
  expect(moved.stderr).toContain("README.md");
  expect(moved.stderr).toContain("MOVED.md");

  expect(cli(root, "bogus").code).toBe(1);
});

const DAY = 86_400_000;
const NOW = new Date("2026-12-31T17:00:00Z");
/** Nightly `v0.16.0-nightly.<stamp>` created `days` before NOW. */
function nightlyAt(days: number) {
  const createdAt = new Date(NOW.getTime() - days * DAY);
  return { tag: `v${nightlyVersion("0.15.1", createdAt)}`, createdAt };
}

test("prune keeps the newest three even when old, recent ones and referenced ones", () => {
  const old = [40, 35, 30, 25, 20].map(nightlyAt);
  // Input order does not matter: the newest are picked by version, and the result lists newest first.
  expect(prunable([...old].reverse(), new Set(), NOW)).toEqual([old[1]!.tag, old[0]!.tag]);
  expect(prunable(old, new Set([old[0]!.tag]), NOW)).toEqual([old[1]!.tag]);
  const mixed = [30, 20, 13, 5, 1, 0].map(nightlyAt);
  expect(prunable(mixed, new Set(), NOW)).toEqual([mixed[1]!.tag, mixed[0]!.tag]);
  expect(prunable(mixed, new Set(), NOW, 14, 0)).toEqual([mixed[1]!.tag, mixed[0]!.tag]);
  expect(prunable(mixed, new Set(), NOW, 3, 2)).toEqual([mixed[3]!.tag, mixed[2]!.tag, mixed[1]!.tag, mixed[0]!.tag]);
  expect(prunable([], new Set(), NOW)).toEqual([]);
});

test("prune never selects a stable or other prerelease tag", () => {
  const old = new Date(NOW.getTime() - 100 * DAY);
  const tags = [{ tag: "v0.15.1", createdAt: old }, { tag: "v0.16.0-rc.1", createdAt: old }, { tag: "v0.16.0-nightly.1", createdAt: old }];
  expect(prunable(tags, new Set(), NOW, 14, 0)).toEqual([]);
});

test("prune reads both nightly feeds and deletes only unreferenced old nightlies", async () => {
  expect([...NIGHTLY_FEED_FILES]).toEqual([DESKTOP_FEED_FILE.nightly, CLI_NIGHTLY_FEED_FILE]);
  const releases = [60, 50, 40, 30, 20, 10].map(nightlyAt);
  const deleted: string[] = [];
  const client: NightlyPruneClient = {
    releases: async () => releases,
    feedVersion: async file => file === "nightly.json" ? releases[0]!.tag.slice(1) : file === "cli-nightly.json" ? null : "unexpected",
    deleteRelease: async tag => { deleted.push(tag); },
  };
  expect(await pruneNightlies(client, NOW, 14, 3, () => {})).toEqual([releases[2]!.tag, releases[1]!.tag]);
  expect(deleted).toEqual([releases[2]!.tag, releases[1]!.tag]);
  // A feed that cannot be read stops the prune before anything is deleted.
  deleted.length = 0;
  client.feedVersion = async () => { throw new Error("HTTP 500"); };
  await expect(pruneNightlies(client, NOW, 14, 3, () => {})).rejects.toThrow("HTTP 500");
  expect(deleted).toEqual([]);
});

test("CLI prune validates its options", () => {
  const root = tmpDir();
  expect(cli(root, "prune", "--keep-days", "x").code).toBe(1);
  expect(cli(root, "prune", "--bogus", "1").code).toBe(1);
});
