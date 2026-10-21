import { z } from "zod";
import { createHash } from "node:crypto";
import { CoreError } from "../../core/errors";
import { isVersion } from "../version";

export type Ownership = "managed" | "attached";
export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "waiting" |
  "reserved" | "installing" | "verifying" | "complete" | "rolling-back" |
  "restored" | "error" | "recovery-failed";
export type Blocker = { kind: "task" | "session" | "launch" | "operation"; id: string; label: string };
export type Installation = {
  id: string; appPath: string; bundleId: string; ownerUid: number;
  arch: "aarch64" | "x86_64"; pacerHome: string; port: number;
  serviceLabel: string; ownership: Ownership; version: string;
};
export type Candidate = {
  version: string; arch: Installation["arch"]; sha256: string;
  signature: string; url: string; protocolMajors: number[];
  rollbackCompatible: boolean; notes: string;
};
export type UpdateAction = "check" | "download" | "restart" | "cancel" | "configure" | "adopt";
/** Private, append-only idempotency ledger. It is never included in public status. */
export type RequestReceipt = {
  requestId: string; action: UpdateAction; fingerprint: string; transactionId: string | null;
};
export type UpdateRecord = {
  schema: 1; installationId: string; revision: number; phase: UpdatePhase;
  candidate: Candidate | null; transactionId: string | null;
  requestId: string | null; requestedBy: string | null; requesterBootId: string | null;
  autoDownload: boolean; checkedAt: number | null; blockers: Blocker[];
  downloadedBytes: number; totalBytes: number | null; failedVersion: string | null;
  error: { code: string; message: string; hint?: string } | null;
  requestHistory: RequestReceipt[];
};
export type AdoptionStatus = { phase: "available" | "waiting" | "reserved" | "installing" | "verifying" | "committed" | "restored" | "recovery-failed" | "cancelled"; revision: number; previousInstallationId: string; resultingInstallationId: string | null; currentServiceExecutable: string; replacementServiceExecutable: string; serviceLabel: string; port: number; blockers: Blocker[]; error: {code:string;message:string} | null };
export type UpdateStatus = Pick<UpdateRecord, "installationId" | "revision" | "phase" |
  "transactionId" | "autoDownload" | "checkedAt" | "blockers" | "downloadedBytes" |
  "totalBytes" | "error"> & {
    current: string; target: string | null; releaseNotes: string | null;
    adoption?: AdoptionStatus; ownership: Ownership; actions: ("check" | "download" | "restart" | "cancel" | "retry" | "adopt" | "adoptCancel" | "configure")[];
  };
export type UpdateRequest = { installationId: string; requestId: string; expectRevision: number };
export type RestartRequest = UpdateRequest & { version: string; clientId: string };

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.string().refine(isVersion);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const phase = z.enum(["idle", "checking", "downloading", "ready", "waiting", "reserved",
  "installing", "verifying", "complete", "rolling-back", "restored", "error", "recovery-failed"]);
const candidateSchema = z.object({
  version, arch: z.enum(["aarch64", "x86_64"]), sha256: hash,
  signature: z.string().min(1), url: z.string().url(),
  protocolMajors: z.array(integer).min(1), rollbackCompatible: z.boolean(), notes: z.string(),
});
const receiptSchema = z.object({
  requestId: identifier, action: z.enum(["check", "download", "restart", "cancel", "configure", "adopt"]),
  fingerprint: hash, transactionId: identifier.nullable(),
});
const recordSchema = z.object({
  schema: z.literal(1), installationId: identifier, revision: integer, phase,
  candidate: candidateSchema.nullable(), transactionId: identifier.nullable(),
  requestId: identifier.nullable(), requestedBy: identifier.nullable(), requesterBootId: identifier.nullable(),
  autoDownload: z.boolean(), checkedAt: z.number().finite().nonnegative().nullable(),
  blockers: z.array(z.object({ kind: z.enum(["task", "session", "launch", "operation"]), id: z.string().min(1), label: z.string() })),
  downloadedBytes: integer, totalBytes: integer.nullable(), failedVersion: version.nullable(),
  error: z.object({ code: z.string().min(1), message: z.string(), hint: z.string().optional() }).nullable(),
  requestHistory: z.array(receiptSchema),
}).superRefine((record, ctx) => {
  if (record.totalBytes !== null && record.downloadedBytes > record.totalBytes) {
    ctx.addIssue({ code: "custom", message: "download exceeds total" });
  }
  const requiresRestartAuthority = ["waiting", "reserved", "installing", "verifying", "rolling-back"].includes(record.phase);
  if ((record.phase === "ready" || requiresRestartAuthority) &&
      (!record.candidate || record.totalBytes === null || record.totalBytes <= 0 || record.downloadedBytes !== record.totalBytes)) {
    ctx.addIssue({ code: "custom", message: "candidate is not complete" });
  }
  // Retain the initiating intent through recovery; these fields do not assert
  // that the desktop is still alive or that this is still the initiating boot.
  if (requiresRestartAuthority) {
    const receipt = record.requestHistory.find(item => item.requestId === record.requestId);
    if (!record.transactionId || !record.requestId || !record.requestedBy || !record.requesterBootId ||
        !receipt || receipt.action !== "restart" || receipt.transactionId !== record.transactionId) {
      ctx.addIssue({ code: "custom", message: "missing restart authority" });
    } else if (record.candidate && receipt.fingerprint !== requestFingerprint({
      version: record.candidate.version, clientId: record.requestedBy,
    })) {
      ctx.addIssue({ code: "custom", message: "restart authority does not match candidate or requester" });
    }
  }
  const ids = new Set(record.requestHistory.map(receipt => receipt.requestId));
  if (ids.size !== record.requestHistory.length) ctx.addIssue({ code: "custom", message: "duplicate request receipt" });
});

export function assertIdentifier(value: unknown): asserts value is string {
  if (!identifier.safeParse(value).success) throw new CoreError("invalid_input", "Invalid desktop update identifier");
}

/** Ignore additive fields, but fail closed on invalid known fields or unsupported schema. */
export function parseUpdateRecord(value: unknown): UpdateRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) {
    throw new CoreError("invalid_input", "Invalid desktop update state", "Keep the state for diagnosis; do not reset a pending update.");
  }
  return parsed.data;
}

/** Shared by request creation, replay and persisted intent validation. */
export function requestFingerprint(parameters: Record<string, string | boolean>): string {
  const canonical = Object.keys(parameters).sort().map(key => [key, parameters[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
