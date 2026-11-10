import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopOrphanedRun } from "../src/supervisor/orphan";

test("orphan cleanup cannot certify death when the process probe fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-probe-"));
  const probe = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("ps unavailable"); });
  try {
    expect(await stopOrphanedRun(dir, 12345, 0, () => undefined)).toBe(false);
  } finally {
    probe.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orphan cleanup refuses a changed stop owner before probing or signalling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pacer-orphan-owner-"));
  const probe = spyOn(Bun, "spawnSync");
  try {
    expect(await stopOrphanedRun(dir, 12345, 0, () => { throw new Error("owner changed"); })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
