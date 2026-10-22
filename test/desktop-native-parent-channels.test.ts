import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "darwin")("atomic parent channels retain usable rights through delayed receipt and explicit acknowledgement", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/parent-channels-boundary.py")], {
    stdout: "pipe", stderr: "pipe", timeout: 25000,
  });
  expect(result.stderr.toString()).toContain("Ran 7 tests");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 30000);
