import { expect, test } from "bun:test";
import { evaluateCondition } from "../scripts/live/control/assertions";
import { createCaptureWriter } from "../scripts/live/control/evidence";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Session } from "../scripts/live/core";
const target = { id: "main", surface: "tui" as const, generation: "g", capabilities: ["inspect" as const] };
const observation = { target, revision: "r", elements: [], text: "Ready\nTask done", truncated: false };
test("conditions distinguish mismatch and inconclusive truncated state", () => {
  expect(evaluateCondition(observation, { text: "Task done" }).verdict).toBe("PASS");
  expect(evaluateCondition(observation, { text: "Failed" }).verdict).toBe("FAIL");
  expect(evaluateCondition({ ...observation, truncated: true }, { text: "Missing", absent: true }).verdict).toBe("UNVERIFIED");
  expect(evaluateCondition(observation, { role: "button", name: "Save" }).verdict).toBe("FAIL");
});
test("capture writer restricts paths and hashes actual artifact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-evidence-")); mkdirSync(join(root, "evidence"));
  try {
    const save = createCaptureWriter({ root } as Session);
    const artifact = await save({ bytes: new TextEncoder().encode("Ready"), method: "terminal", mime: "text/plain" }, target, "safe-id");
    expect(artifact.path.startsWith("captures/")).toBe(true);
    expect(readFileSync(join(root, "evidence", artifact.path), "utf8")).toBe("Ready");
    expect(artifact.sha256).toHaveLength(64);
    await expect(save({ bytes: new Uint8Array([1]), method: "window", mime: "image/png" }, target, "../../escape")).rejects.toThrow();
  } finally { rmSync(root, { force: true, recursive: true }); }
});
