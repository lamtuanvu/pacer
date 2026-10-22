import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "darwin")("helper H receipt is acknowledged only after validation and preserves all delayed rights", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/helper-receipt-boundary.py")], {
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(result.stderr.toString()).toContain("Ran 2 tests");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 15000);
