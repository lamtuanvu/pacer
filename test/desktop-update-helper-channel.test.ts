import { expect, test } from "bun:test";
import { join } from "node:path";

test.skipIf(process.platform !== "darwin")("helper shim validates real Unix rights, framing, directions and leak cleanup", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/helper-channel-boundary.py")], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(new TextDecoder().decode(result.stderr)).toContain("OK");
  expect(result.exitCode).toBe(0);
});
