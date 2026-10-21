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

test("each step keeps immutable provenance across later source revisions", async () => {
  const { recordStep } = await import("../scripts/live/control/evidence");
  const root = mkdtempSync(join(tmpdir(), "live-provenance-")); mkdirSync(join(root, "evidence"));
  try {
    const session = { id: "provenance", root } as Session;
    const first = { schema_version: 1 as const, command_id: "first", command: "inspect", started_at: "now", finished_at: "now", outcome: "ok" as const, artifacts: [] };
    const { recordProvenance } = await import("../scripts/live/control/provenance");
    recordStep(session, { ...first, provenance: recordProvenance(session, { head: "revision-one", dirty_fingerprint: "one" }) });
    const stored = JSON.parse(readFileSync(join(root, "evidence/steps/first.json"), "utf8"));
    expect(stored.provenance?.path).toMatch(/^provenance\//);
    const original = readFileSync(join(root, "evidence", stored.provenance.path), "utf8");
    recordStep(session, { ...first, command_id: "second", provenance: recordProvenance(session, { head: "revision-two", dirty_fingerprint: "two" }) });
    expect(readFileSync(join(root, "evidence", stored.provenance.path), "utf8")).toBe(original);
    expect(JSON.parse(original).source.head).toBe("revision-one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("saved native artifact retains capture-time producer identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "live-producer-")); mkdirSync(join(root, "evidence"));
  try {
    const producer = { method: "content" as const, scale: 1, window_id: "42", pid: 123,
      app_version: "0.5.0", app_sha256: "a".repeat(64), captured_at_ms: 12345,
      viewport_width: 1, viewport_height: 1, width: 1, height: 1 };
    const bytes = readFileSync(join(import.meta.dir, "fixtures/live-control/one-pixel.png"));
    const artifact = await createCaptureWriter({ root } as Session)({ bytes, method: "content", mime: "image/png", producer }, target, "native-producer");
    expect(artifact.producer).toEqual(producer);
    expect(artifact.width).toBe(1);
    expect(artifact.height).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
