import { createHash } from "node:crypto";
import { CoreError } from "../../../core/errors";
import { compareVersions, isVersion } from "../../version";
import releases from "./releases.json";
import { legacySourceEvidenceSchema, type LegacyReleaseInspection } from "./types";

/** Known artifacts are not automatically eligible sources. No current legacy entry has exclusion. */
export function inspectLegacyRelease(sha256: string, arch: "aarch64" | "x86_64", destinationVersion: string): LegacyReleaseInspection {
  if (!isVersion(destinationVersion)) throw new CoreError("invalid_input", "Invalid desktop destination version");
  const release = releases.find(release => release.sha256 === sha256 && release.arch === arch);
  if (!release) return { supported: false, reason: "unknown-release", version: null };
  if (compareVersions(destinationVersion, release.version) < 0) return { supported: false, reason: "destination-older", version: release.version };
  return { supported: false, reason: "legacy-update-bypasses-reservation", version: release.version };
}

export function legacySourceFingerprint(untrusted: unknown): string {
  const parsed = legacySourceEvidenceSchema.safeParse(untrusted);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid legacy service identity");
  const evidence = parsed.data;
  return createHash("sha256").update("pacer-legacy-source-v1\n").update(JSON.stringify(evidence)).digest("hex");
}

export function reverifyLegacySource(approved: unknown, current: unknown): void {
  if (legacySourceFingerprint(approved) !== legacySourceFingerprint(current)) {
    throw new CoreError("conflict", "Legacy service identity changed", "Inspect the service again before authorizing a change.");
  }
}
