import { createHash, randomUUID } from "node:crypto";
import { CoreError } from "../../core/errors";
import { updateChecksEnabled, UPDATE_CACHE_S } from "../check";
import {
  assertIdentifier, type Installation, type RequestReceipt, type RestartRequest,
  type UpdateAction, type UpdateRecord, type UpdateRequest, type UpdateStatus,
} from "./types";

/** Reuse both environment and active-strategy opt-outs, including explicit checks. */
export const checksEnabled = updateChecksEnabled;

/** Persisted timestamps and now are Unix seconds. */
export function checkDue(checkedAt: number | null, now: number): boolean {
  return checkedAt === null || now < checkedAt || now - checkedAt >= UPDATE_CACHE_S;
}

type RequestParameters = Record<string, string | boolean>;
function fingerprint(parameters: RequestParameters): string {
  const canonical = Object.keys(parameters).sort().map(key => [key, parameters[key]]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

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
    if (receipt.action !== action || receipt.fingerprint !== fingerprint(parameters)) {
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
      requestId: request.requestId, action, fingerprint: fingerprint(parameters), transactionId: record.transactionId,
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

export function updateStatus(installation: Installation, record: UpdateRecord): UpdateStatus {
  if (installation.id !== record.installationId) throw new CoreError("conflict", "Desktop update conflict: installation changed");
  const actions: UpdateStatus["actions"] = [];
  switch (record.phase) {
    case "idle": case "complete":
      actions.push("check");
      if (record.candidate && record.candidate.version !== installation.version) actions.push("download");
      break;
    case "ready":
      actions.push("check");
      if (record.candidate && record.totalBytes !== null && record.totalBytes > 0 && record.downloadedBytes === record.totalBytes) {
        actions.push("restart");
      }
      break;
    case "waiting":
      actions.push("cancel");
      break;
    case "error": case "restored":
      actions.push("check", "retry");
      if (record.candidate) actions.push("download");
      break;
  }
  if (installation.ownership === "attached" && ["idle", "ready", "complete", "error", "restored"].includes(record.phase)) {
    actions.push("adopt");
  }
  return {
    installationId: record.installationId, revision: record.revision, phase: record.phase,
    transactionId: record.transactionId, autoDownload: record.autoDownload,
    checkedAt: record.checkedAt, blockers: record.blockers.map(({ kind, id, label }) => ({ kind, id, label })),
    downloadedBytes: record.downloadedBytes, totalBytes: record.totalBytes,
    error: record.error ? { code: record.error.code, message: record.error.message,
      ...(record.error.hint === undefined ? {} : { hint: record.error.hint }) } : null,
    current: installation.version, target: record.candidate?.version ?? null,
    releaseNotes: record.candidate?.notes ?? null, ownership: installation.ownership, actions,
  };
}
