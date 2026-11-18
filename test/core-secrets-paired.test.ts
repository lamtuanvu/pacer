import { expect, test } from "bun:test";
import { join } from "node:path";

// A signed paired Core reads its secrets frame from the authenticated parent channel, after the
// `B` descriptor byte and its own `A` (#918, ADR 0027 item 9). This drives the real descriptor
// shim and Core's real reader; serve's side of the order is `native_bootstrap` in pacer-server.
test.skipIf(process.platform !== "darwin")("a paired native Core reads its frame only after acknowledging its parent channel", () => {
  const result = Bun.spawnSync(["python3", join(import.meta.dir, "fixtures/desktop-update/paired-secrets-frame.py")], {
    env: { ...process.env, PACER_TEST_BUN: process.execPath },
    stdout: "pipe", stderr: "pipe", timeout: 60000,
  });
  expect(result.stderr.toString()).toContain("Ran 3 tests");
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, 70000);
