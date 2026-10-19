import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Ctx } from "../../types";
import { CoreError } from "../../core/errors";
import { assertIdentifier, parseUpdateRecord, type UpdateRecord } from "./types";

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function boundaryError(error: unknown): CoreError {
  if (error instanceof CoreError) return error;
  return new CoreError("not_allowed", "Cannot access desktop update state", "Check the service home's ownership and permissions; retain pending recovery state.");
}

function stateDirectory(ctx: Ctx, create: boolean): string {
  const dir = join(ctx.pacerHome, "desktop-updates");
  if (create) {
    mkdirSync(ctx.pacerHome, { recursive: true, mode: 0o700 });
    syncDirectory(dirname(ctx.pacerHome));
    try {
      mkdirSync(dir, { mode: 0o700 });
      syncDirectory(ctx.pacerHome);
    }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
  }
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new CoreError("not_allowed", "Desktop update directory must be private and owned by the service user");
    }
  } catch (error) {
    if (!create && hasCode(error, "ENOENT")) return dir;
    throw error;
  }
  return dir;
}

function initialRecord(installationId: string): UpdateRecord {
  return {
    schema: 1, installationId, revision: 0, phase: "idle", candidate: null,
    transactionId: null, requestId: null, requestedBy: null, requesterBootId: null,
    autoDownload: true, checkedAt: null, blockers: [], downloadedBytes: 0,
    totalBytes: null, failedVersion: null, error: null, requestHistory: [],
  };
}

export function readUpdate(ctx: Ctx, installationId: string): UpdateRecord {
  assertIdentifier(installationId);
  let fd: number | undefined;
  try {
    const dir = stateDirectory(ctx, false);
    try { fd = openSync(join(dir, `${installationId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (hasCode(error, "ENOENT")) return initialRecord(installationId);
      throw error;
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new CoreError("not_allowed", "Desktop update state must be a private regular file");
    }
    let value: unknown;
    try { value = JSON.parse(readFileSync(fd, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new CoreError("invalid_input", "Invalid desktop update state JSON");
      throw error;
    }
    const record = parseUpdateRecord(value);
    if (record.installationId !== installationId) throw new CoreError("invalid_input", "Desktop update installation identity mismatch");
    return record;
  } catch (error) { throw boundaryError(error); }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch (error) { throw boundaryError(error); }
    }
  }
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * CAS is serialized across processes by desktop-updates/<id>.lock, opened wx.
 * A crashed owner leaves the lock in place. Never steal it by age: reconciliation
 * must prove owner death and transaction safety before removing an orphan.
 */
export function writeUpdate(ctx: Ctx, next: UpdateRecord, expectRevision: number): UpdateRecord {
  assertIdentifier(next.installationId);
  const valid = parseUpdateRecord(next);
  if (!Number.isSafeInteger(expectRevision) || expectRevision < 0) {
    throw new CoreError("invalid_input", "Invalid desktop update revision");
  }
  if (ctx.readOnly) throw new CoreError("not_allowed", "Desktop update state is read-only");
  let lockFd: number | undefined;
  let lockPath: string | undefined;
  let tempPath: string | undefined;
  try {
    const dir = stateDirectory(ctx, true);
    lockPath = join(dir, `${valid.installationId}.lock`);
    try { lockFd = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (hasCode(error, "EEXIST")) {
        throw new CoreError("conflict", "Desktop update conflict: installation is locked", "Retry after the owner finishes; an abandoned lock requires recovery.");
      }
      throw error;
    }
    writeFileSync(lockFd, JSON.stringify({ schema: 1, pid: process.pid, nonce: randomUUID() }) + "\n");
    fsyncSync(lockFd);
    syncDirectory(dir);
    const current = readUpdate(ctx, valid.installationId);
    if (current.revision !== expectRevision || valid.revision !== expectRevision || expectRevision === Number.MAX_SAFE_INTEGER) {
      throw new CoreError("conflict", "Desktop update conflict: revision changed", "Read the current status and retry.");
    }
    for (const receipt of current.requestHistory) {
      const retained = valid.requestHistory.find(item => item.requestId === receipt.requestId);
      if (!retained || retained.action !== receipt.action || retained.fingerprint !== receipt.fingerprint || retained.transactionId !== receipt.transactionId) {
        throw new CoreError("conflict", "Desktop update conflict: request history cannot be changed");
      }
    }
    const written = { ...valid, revision: expectRevision + 1 };
    const temporary = join(dir, `${valid.installationId}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    tempPath = temporary;
    try {
      writeFileSync(fd, JSON.stringify(written) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tempPath, join(dir, `${valid.installationId}.json`));
    tempPath = undefined;
    syncDirectory(dir);
    return written;
  } catch (error) { throw boundaryError(error); }
  finally {
    // Never unlink another owner's lock, even if an external reconciler changed it.
    if (lockFd !== undefined && lockPath) {
      try {
        if (tempPath) unlinkSync(tempPath);
        const owned = fstatSync(lockFd), actual = lstatSync(lockPath);
        if (owned.dev === actual.dev && owned.ino === actual.ino) {
          unlinkSync(lockPath);
          syncDirectory(join(ctx.pacerHome, "desktop-updates"));
        }
      } catch (error) { throw boundaryError(error); }
      finally {
        try { closeSync(lockFd); } catch (error) { throw boundaryError(error); }
      }
    }
  }
}
