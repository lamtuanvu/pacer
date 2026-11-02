import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** Local content evidence for the non-publishing experiment; this is not an attestation. */
export interface ExperimentIdentity {
  repository: string;
  run: string;
  attempt: string;
  commit: string;
  version: string;
  variant: string;
}

export interface ExperimentManifest extends ExperimentIdentity {
  files: { name: string; size: number; sha256: string }[];
}

const identityFields = ["repository", "run", "attempt", "commit", "version", "variant"] as const;

export function validateIdentity(identity: ExperimentIdentity): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(identity.repository) ||
      !/^[1-9]\d*$/.test(identity.run) || !/^[1-9]\d*$/.test(identity.attempt) ||
      !/^[0-9a-f]{40}$/.test(identity.commit) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(identity.version) ||
      !/^[a-z0-9-]+$/.test(identity.variant)) throw new Error("invalid experiment identity");
}

export function inspectExperimentFile(directory: string, name: string): ExperimentManifest["files"][number] {
  if (!name || name === "." || name === ".." || basename(name) !== name || name.includes("\\")) {
    throw new Error("invalid artifact filename");
  }
  const path = join(directory, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact is not a regular file: ${name}`);
  const bytes = readFileSync(path);
  return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function createExperimentManifest(identity: ExperimentIdentity, directory: string, names: string[]): ExperimentManifest {
  validateIdentity(identity);
  if (!names.length || new Set(names).size !== names.length) throw new Error("missing or duplicate artifacts");
  return { ...identity, files: names.map(name => inspectExperimentFile(directory, name)) };
}

/** The expected identity and filenames must come from the consumer, not the manifest. */
export function verifyExperimentManifest(manifest: ExperimentManifest, expected: ExperimentIdentity, directory: string, names: string[]): void {
  validateIdentity(expected);
  if (!manifest || identityFields.some(field => manifest[field] !== expected[field])) throw new Error("experiment identity mismatch");
  const actual = createExperimentManifest(expected, directory, names);
  if (!Array.isArray(manifest.files) || manifest.files.length !== actual.files.length) throw new Error("artifact set mismatch");
  for (const file of actual.files) {
    const matches = manifest.files.filter(item => item?.name === file.name);
    if (matches.length !== 1 || matches[0].size !== file.size || matches[0].sha256 !== file.sha256) {
      throw new Error(`artifact mismatch: ${file.name}`);
    }
  }
}
