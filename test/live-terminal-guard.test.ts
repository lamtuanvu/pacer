import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";

const guard = await import("../scripts/live/proxy").catch(() => ({} as typeof import("../scripts/live/proxy")));

test("live proxy permits a shell only in its disposable repo or home", () => {
  const root = tmpDir();
  const repo = join(root, "repo"), home = join(root, "home"), outside = tmpDir();
  mkdirSync(repo); mkdirSync(home);
  const nested = join(repo, "nested"); mkdirSync(nested);
  const linked = join(repo, "escape"); symlinkSync(outside, linked);
  expect(guard.safeTerminalFolder(root, repo)).toBe(true);
  expect(guard.safeTerminalFolder(root, nested)).toBe(true);
  expect(guard.safeTerminalFolder(root, home)).toBe(true);
  expect(guard.safeTerminalFolder(root, outside)).toBe(false);
  expect(guard.safeTerminalFolder(root, linked)).toBe(false);
  expect(guard.safeTerminalFolder(root, undefined)).toBe(false);
});

test("live proxy lets a ui-seeded shell default to its sandbox home, but no other sandbox", () => {
  const root = tmpDir(); mkdirSync(join(root, "home")); mkdirSync(join(root, "repo"));
  expect(guard.safeShellCreate({ root, seed: "ui" }, { kind: "shell" })).toBe(true);
  expect(guard.safeShellCreate({ root }, { kind: "shell" })).toBe(false);
  expect(guard.safeShellCreate({ root, seed: "ui" }, { kind: "shell", cwd: tmpDir() })).toBe(false);
  expect(guard.safeShellCreate({ root, seed: "ui" }, { kind: "shell", cwd: join(root, "repo") })).toBe(true);
  expect(guard.safeShellCreate({ root, seed: "ui" }, { kind: "action" })).toBe(false);
  expect(guard.safeShellCreate({ root, seed: "ui" }, null)).toBe(false);
});
