import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, release } from "node:os";
import { atomicWrite, checkout, type Session } from "../core";
import { sourceFingerprint, type SourceFingerprint } from "./fingerprint";
export { sourceFingerprint } from "./fingerprint";
export interface ProvenanceRef { id: string; path: string }
export function recordProvenance(session: Session, source = sourceFingerprint(checkout)): ProvenanceRef {
  const document = JSON.stringify({
    schema_version: 1, run_id: session.id, source, runtime: Bun.version,
    platform: process.platform, os_release: release(), architecture: arch(),
    data: session.seed ? "synthetic" : "real", captured_at: new Date().toISOString(),
    service_source: session.serviceSource ?? "unverified-legacy-session",
    desktop_build: session.desktopExecutable?.includes("/debug/") ? "debug" : session.desktopExecutable ? "release-or-external" : "absent",
    desktop_sha256: session.desktopSha256 ?? "unverified-legacy-session",
  }, null, 2) + "\n";
  const id = createHash("sha256").update(document).digest("hex");
  const directory = join(session.root, "evidence", "provenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ref = { id, path: `provenance/${id}.json` };
  try { writeFileSync(join(directory, `${id}.json`), document, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(join(directory, `${id}.json`), "utf8") !== document) throw error;
  }
  // This is only an index. Historical steps retain their immutable references.
  atomicWrite(join(session.root, "evidence", "provenance.json"), JSON.stringify(ref) + "\n");
  return ref;
}
