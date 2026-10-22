import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "darwin")("production clang helper failure diagnostics preserve refusal, rights cleanup and success", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/helper-failure-boundary.py")], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  expect(result.stderr.toString()).toContain("Ran 6 tests");
  expect(result.exitCode).toBe(0);
});
