import { createHash } from "node:crypto";
import { currentVersion } from "../version";
declare const PACER_COMPONENT_BUILD_ID: string | undefined;
declare const PACER_COMPONENT_TARGET_OS: string | undefined;
declare const PACER_COMPONENT_TARGET_ARCH: string | undefined;

export function coreBuildDescriptor(): ComponentDescriptor {
  return { schemaVersion: 1, releaseVersion: currentVersion(), buildId: typeof PACER_COMPONENT_BUILD_ID === "string" ? PACER_COMPONENT_BUILD_ID : "development-uncompiled", role: "core", targetOs: typeof PACER_COMPONENT_TARGET_OS === "string" ? PACER_COMPONENT_TARGET_OS : process.platform, targetArch: typeof PACER_COMPONENT_TARGET_ARCH === "string" ? PACER_COMPONENT_TARGET_ARCH : process.arch };
}

/** V1 canonical bytes are UTF-8 JSON in the field order below, with no whitespace or newline.
 * Descriptors are claims, never hashes of themselves or their embedded peer. */
export interface ComponentDescriptor {
  schemaVersion: 1;
  releaseVersion: string;
  buildId: string;
  role: "front-door" | "core";
  targetOs: string;
  targetArch: string;
}
export interface PairManifest {
  schemaVersion: 1;
  frontDoor: { descriptor: ComponentDescriptor; sha256: string };
  core: { descriptor: ComponentDescriptor; sha256: string };
}
export type IdentityAssessment =
  | { status: "unknown"; reason: "invalid-manifest" }
  | { status: "mismatch"; reason: "pair-differs" }
  | { status: "unverified"; reason: "native-proof-unavailable" };

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const bounded = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9._+-]{1,128}$/.test(v);
function descriptor(v: unknown, role: ComponentDescriptor["role"]): ComponentDescriptor | null {
  if (!object(v) || !fields(v, ["schemaVersion", "releaseVersion", "buildId", "role", "targetOs", "targetArch"]) || v.schemaVersion !== 1 || v.role !== role || !bounded(v.releaseVersion) || !bounded(v.buildId) || !bounded(v.targetOs) || !bounded(v.targetArch)) return null;
  return { schemaVersion: 1, releaseVersion: v.releaseVersion, buildId: v.buildId, role, targetOs: v.targetOs, targetArch: v.targetArch };
}
function entry(v: unknown, role: ComponentDescriptor["role"]): PairManifest["core"] | null {
  if (!object(v) || !fields(v, ["descriptor", "sha256"]) || typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
  const d = descriptor(v.descriptor, role);
  return d ? { descriptor: d, sha256: v.sha256 } : null;
}
function parse(v: unknown): PairManifest | null {
  if (!object(v) || !fields(v, ["schemaVersion", "frontDoor", "core"]) || v.schemaVersion !== 1) return null;
  const frontDoor = entry(v.frontDoor, "front-door"), core = entry(v.core, "core");
  if (!frontDoor || !core || frontDoor.descriptor.targetOs !== core.descriptor.targetOs || frontDoor.descriptor.targetArch !== core.descriptor.targetArch) return null;
  return { schemaVersion: 1, frontDoor, core };
}
export function encodePairManifest(manifest: PairManifest): string {
  const canonical = parse(manifest);
  if (!canonical) throw Error("invalid pair manifest");
  return JSON.stringify(canonical);
}
export function measurePair(front: ComponentDescriptor, core: ComponentDescriptor, frontBytes: Uint8Array, coreBytes: Uint8Array): PairManifest {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const manifest = parse({ schemaVersion: 1, frontDoor: { descriptor: front, sha256: sha256(frontBytes) }, core: { descriptor: core, sha256: sha256(coreBytes) } });
  if (!manifest) throw Error("invalid component descriptors");
  return manifest;
}
/** Diagnostic comparison only. No native verifier exists yet; caller data cannot confer trust. */
export function assessIdentity(claim: unknown, _nativeEvidence: unknown, manifest: unknown): IdentityAssessment {
  const a = parse(claim), b = parse(manifest);
  if (!a || !b) return { status: "unknown", reason: "invalid-manifest" };
  if (encodePairManifest(a) !== encodePairManifest(b)) return { status: "mismatch", reason: "pair-differs" };
  return { status: "unverified", reason: "native-proof-unavailable" };
}

/** Validate canonical manifest bytes against final component bytes; this does not verify a signature. */
export function verifyPairBinding(bytes: string | null, front: Uint8Array, core: Uint8Array): PairManifest {
  if (bytes === null || bytes.length > 8192) throw Error("Missing or invalid pair manifest");
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw Error("Invalid pair manifest"); }
  const manifest = parse(value);
  if (!manifest || encodePairManifest(manifest) !== bytes || encodePairManifest(measurePair(manifest.frontDoor.descriptor, manifest.core.descriptor, front, core)) !== bytes) throw Error("Invalid pair manifest binding");
  return manifest;
}
