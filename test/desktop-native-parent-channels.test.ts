import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { tmpDir } from "./helpers";

test.skipIf(process.platform !== "darwin")("atomic parent channels retain usable rights through delayed receipt and explicit acknowledgement", () => {
  const root = join(tmpDir(), "parent-channels-long-temp-" + "x".repeat(120));
  mkdirSync(root, { mode: 0o700 });
  expect(Buffer.byteLength(root)).toBeGreaterThan(104);
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/parent-channels-boundary.py")], {
    env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
    stdout: "pipe", stderr: "pipe", timeout: 25000,
  });
  expect(result.stderr.toString()).toContain("Ran 7 tests");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readdirSync(root), "Python fixture roots and socket files are removed").toEqual([]);
}, 30000);
