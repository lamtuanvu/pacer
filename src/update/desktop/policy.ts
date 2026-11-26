import { randomUUID } from "node:crypto";
import { CoreError } from "../../core/errors";
import { updateChecksEnabled, UPDATE_CACHE_S } from "../check";
import { compareVersions } from "../version";
import {
  assertIdentifier, requestFingerprint, type Installation, type RequestReceipt, type RestartRequest,
  type UpdateAction, type UpdatePhase, type UpdateRecord, type UpdateRequest, type UpdateStatus,
} from "./types";

/** Reuse both environment and active-strategy opt-outs, including explicit checks. */
export const checksEnabled = updateChecksEnabled;

/** Persisted timestamps and now are Unix seconds. */
export function checkDue(checkedAt: number | null, now: number): boolean {
  return checkedAt === null || now < checkedAt || now - checkedAt >= UPDATE_CACHE_S;
}

type RequestParameters = Record<string, string | boolean>;

/** Check replay BEFORE revision: a retried request normally carries its old revision. */
export function replayRequest(
  record: UpdateRecord, request: UpdateRequest, action: UpdateAction, parameters: RequestParameters = {},
): RequestReceipt | null {
  assertIdentifier(request.installationId);
  assertIdentifier(request.requestId);
  if (!Number.isSafeInteger(request.expectRevision) || request.expectRevision < 0) {
    throw new CoreError("invalid_input", "Invalid desktop update revision");
  }
  if (record.installationId !== request.installationId) throw new CoreError("conflict", "Desktop update conflict: installation changed");
  const receipt = record.requestHistory.find(item => item.requestId === request.requestId);
  if (receipt) {
    if (receipt.action !== action || receipt.fingerprint !== requestFingerprint(parameters)) {
      throw new CoreError("conflict", "Desktop update conflict: request ID was already used for different input");
    }
    return receipt;
  }
  if (record.revision !== request.expectRevision) throw new CoreError("conflict", "Desktop update conflict: revision changed", "Read the current status and retry.");
  return null;
}

/** Append before CAS persistence; callers must include every action parameter. */
export function rememberRequest(
  record: UpdateRecord, request: UpdateRequest, action: UpdateAction, parameters: RequestParameters = {},
): UpdateRecord {
  if (replayRequest(record, request, action, parameters)) return record;
  return {
    ...record,
    requestHistory: [...record.requestHistory, {
      requestId: request.requestId, action, fingerprint: requestFingerprint(parameters), transactionId: record.transactionId,
    }],
  };
}

export function requestRestart(record: UpdateRecord, request: RestartRequest, bootId: string): UpdateRecord {
  assertIdentifier(request.clientId);
  assertIdentifier(bootId);
  const parameters = { version: request.version, clientId: request.clientId };
  const receipt = replayRequest(record, request, "restart", parameters);
  if (receipt) {
    if (record.transactionId !== receipt.transactionId || record.requestId !== request.requestId ||
        record.requesterBootId !== bootId || record.requestedBy !== request.clientId) {
      throw new CoreError("conflict", "Desktop update conflict: restart permission expired", "Use a new request ID after reviewing the current candidate.");
    }
    return record;
  }
  if (record.phase !== "ready" || !record.candidate || record.candidate.version !== request.version ||
      record.totalBytes === null || record.totalBytes <= 0 || record.downloadedBytes !== record.totalBytes) {
    throw new CoreError("conflict", "Desktop update conflict: the approved candidate is not ready", "Read the current status before requesting restart.");
  }
  const waiting: UpdateRecord = {
    ...record, phase: "waiting", transactionId: randomUUID(), requestId: request.requestId,
    requestedBy: request.clientId, requesterBootId: bootId, error: null,
  };
  return rememberRequest(waiting, request, "restart", parameters);
}

export function cancelRestart(record: UpdateRecord): UpdateRecord {
  if (record.phase === "ready" && record.requestId === null) return record;
  if (record.phase !== "waiting") {
    throw new CoreError("conflict", "Desktop update conflict: cancellation is unavailable", "Installation cannot be cancelled after reservation.");
  }
  return { ...record, phase: "ready", requestId: null, requestedBy: null, requesterBootId: null, blockers: [] };
}

/** Phases that still own restart authority, an active network operation or
 * durable recovery work. Their candidate must survive even if the registered
 * installation has already moved to its version; only their own work settles it. */
const CANDIDATE_IN_USE: ReadonlySet<UpdatePhase> = new Set([
  "checking", "downloading", "waiting", "reserved", "installing", "verifying",
  "rolling-back", "recovery-failed", "complete",
]);

/**
 * A candidate that is no newer than the registered installation is not an update
 * any more: the target was installed by another path (for example by hand). Its
 * target and any error attached to it are stale and must not surface in status.
 * Returns the same object when nothing needs to change, so callers can persist
 * only a real reconciliation (with its revision bump).
 */
export function reconcileStaleCandidate(installation: Installation, record: UpdateRecord): UpdateRecord {
  const candidate = record.candidate;
  if (!candidate || compareVersions(candidate.version, installation.version) > 0) return record;
  if (CANDIDATE_IN_USE.has(record.phase)) return record;
  // A transaction id still names a reservation that reconcile must release first; clearing the
  // record now would hide it from that release branch and leave new work blocked.
  if (record.transactionId !== null) return record;
  return {
    ...record,
    phase: "idle",
    candidate: null,
    error: null,
    checkedAt: null,
    downloadedBytes: 0,
    totalBytes: null,
  };
}

export function updateStatus(installation: Installation, record: UpdateRecord): UpdateStatus {
  if (installation.id !== record.installationId) throw new CoreError("conflict", "Desktop update conflict: installation changed");
  const value = reconcileStaleCandidate(installation, record);
  const actions: UpdateStatus["actions"] = [];
  switch (value.phase) {
    case "idle": case "complete":
      actions.push("check");
      if (value.candidate && value.candidate.version !== installation.version) actions.push("download");
      break;
    case "ready":
      actions.push("check");
      if (value.candidate && value.totalBytes !== null && value.totalBytes > 0 && value.downloadedBytes === value.totalBytes) {
        actions.push("restart");
      }
      break;
    case "checking": case "downloading": case "waiting":
      actions.push("cancel");
      break;
    case "error": case "restored":
      actions.push("check", "retry");
      if (value.candidate) actions.push("download");
      break;
  }
  if (!["reserved", "installing", "verifying", "rolling-back", "recovery-failed"].includes(value.phase)) actions.push("configure");
  if (installation.ownership === "attached" && ["idle", "ready", "complete", "error", "restored"].includes(value.phase)) {
    actions.push("adopt");
  }
  return {
    installationId: value.installationId, revision: value.revision, phase: value.phase,
    transactionId: value.transactionId, autoDownload: value.autoDownload,
    checkedAt: value.checkedAt, blockers: value.blockers.map(({ kind, id, label }) => ({ kind, id, label })),
    downloadedBytes: value.downloadedBytes, totalBytes: value.totalBytes,
    error: value.error ? { code: value.error.code, message: value.error.message,
      ...(value.error.hint === undefined ? {} : { hint: value.error.hint }) } : null,
    current: installation.version, target: value.candidate?.version ?? null,
    releaseNotes: value.candidate?.notes ?? null, ownership: installation.ownership, actions,
  };
}
