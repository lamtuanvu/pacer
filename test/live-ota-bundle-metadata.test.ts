import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFixtureBundleMetadata } from "../scripts/live/ota-bundle-metadata";
import { privateFixtureBytes } from "../scripts/live/ota-exercise";

function fixture(run: (app: string, path: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pacer-bundle-metadata-"));
  const app = join(root, "current.app"), resources = join(app, "Contents/Resources");
  mkdirSync(resources, { recursive: true });
  const path = join(resources, "pacer-release.json");
  writeFileSync(path, '{"version":"0.2.4"}', { mode: 0o644 });
  // Public metadata must stay public even when the test runner uses umask 077.
  chmodSync(path, 0o644);
  try { run(app, path); } finally { rmSync(root, { recursive: true, force: true }); }
}
test("signed public bundle metadata accepts 0644 without weakening private evidence", () => fixture((app, path) => {
  expect(statSync(path).mode & 0o7777).toBe(0o644);
  expect(readFixtureBundleMetadata(app)).toBe(readFileSync(path, "utf8"));
  expect(() => privateFixtureBytes(path, 65536)).toThrow();
}));
for (const mode of [0o664, 0o646]) test(`bundle metadata rejects writable public mode ${mode.toString(8)}`, () => fixture((app, path) => {
  chmodSync(path, mode);
  expect(() => readFixtureBundleMetadata(app)).toThrow();
}));
test("bundle metadata rejects symlink, hardlink and oversized input", () => fixture((app, path) => {
  const original = path + ".original";
  writeFileSync(original, "{}"); rmSync(path); symlinkSync(original, path);
  expect(() => readFixtureBundleMetadata(app)).toThrow();
  rmSync(path); linkSync(original, path);
  expect(() => readFixtureBundleMetadata(app)).toThrow();
  rmSync(path); writeFileSync(path, "x".repeat(65537), { mode: 0o644 });
  expect(() => readFixtureBundleMetadata(app)).toThrow();
}));
test("bundle metadata rejects nonregular and ancestor symlink paths", () => fixture((app, path) => {
  rmSync(path); mkdirSync(path);
  expect(() => readFixtureBundleMetadata(app)).toThrow();
  const alias = app + ".alias"; symlinkSync(app, alias);
  expect(() => readFixtureBundleMetadata(alias)).toThrow();
}));

test("bundle metadata accepts the exact 64KiB public bound", () => fixture((app, path) => {
  writeFileSync(path, "x".repeat(65536));
  expect(readFixtureBundleMetadata(app).length).toBe(65536);
}));
