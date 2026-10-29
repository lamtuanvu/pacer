import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers";
import { readEvidence, record, renderReport, type Session } from "../scripts/live/core";
import { recordOtaEvent } from "../scripts/live/ota-evidence";

function fixture(): Session {
  const root = tmpDir();
  mkdirSync(join(root, "evidence"), { mode: 0o700 });
  return {
    id: "ota-event-evidence", root, port: 49190, innerPort: 49191,
    pid: 12345, proxyPid: 12346, createdAt: new Date().toISOString(),
  };
}

test("OTA event traces remain evidence without becoming unverified behavior claims", () => {
  const session = fixture();
  const event = { seq: 1, at: 123, type: "desktop.update" as const, data: { phase: "complete" } };
  record(session, { kind: "note", behavior: "OTA upgrade", surface: "desktop", verdict: "PASS", text: "Validated final outcome" });
  recordOtaEvent(session, "upgrade", event);
  const entries = readEvidence(session);
  expect(entries.at(-1)?.text).toContain(JSON.stringify(event));
  expect(renderReport(session, entries)).toContain("Summary: 1 PASS, 0 FAIL, 0 UNVERIFIED.");
  expect(renderReport(session, entries)).toContain(JSON.stringify(event));
});

test("missing behavior verdicts remain unverified and non-OTA events are ignored", () => {
  const session = fixture();
  record(session, { kind: "note", behavior: "Native keyboard", surface: "desktop", text: "Not exercised" });
  recordOtaEvent(session, "adopt", { seq: 2, at: 123, type: "task", data: {} });
  expect(readEvidence(session)).toHaveLength(1);
  expect(renderReport(session)).toContain("Summary: 0 PASS, 0 FAIL, 1 UNVERIFIED.");
});
