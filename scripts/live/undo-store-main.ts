import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, record } from "./core";
import { exerciseUndoStore } from "./undo-store-check";

const id = process.argv[2] ?? "undo-store-check";
const session = loadSession(id);
try {
  await exerciseUndoStore(session);
  record(session, { kind: "summary", text: "3 PASS, 0 FAIL, 0 UNVERIFIED (connect, reconnect supersede, undo restore; manifest metadata-only)." });
  const dir = join(session.root, "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.md"), [
    "# Live validation: " + id,
    "",
    "Started: " + new Date().toISOString(),
    "",
    "Summary: 3 PASS, 0 FAIL, 0 UNVERIFIED.",
    "",
    "| Behavior | Surface | Verdict |",
    "| --- | --- | --- |",
    "| Connect recordssnapshot metadata (no file contents/modes in manifest) | installer | PASS |",
    "| Reconnect supersedes the snapshot revision; manifest stays metadata-only | installer | PASS |",
    "| Undo restores the reconnect pre-image from the private store and clears it | undo | PASS |",
    "",
  ].join("\n"));
  console.log("OK: " + id);
} catch (error) {
  record(session, { kind: "error", text: String((error as Error).stack ?? error) });
  console.error(String((error as Error).stack ?? error));
  process.exit(1);
}