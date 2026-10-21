import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { withDesktopCoordinator } from "./coordinator";
import { readUpdate } from "./store";
import {
  assertIdentifier,
  requestFingerprint,
  type UpdateRequest,
} from "./types";
import type { Ctx } from "../../types";
import {
  adoptionAuthoritySchema,
  adoptionConflict,
  adoptionPending,
  adoptionRows,
  adoptionReplay,
  assertNoPendingAdoption,
  saveAdoption,
  type AdoptionAuthority,
  type AdoptionPhase,
  type AdoptionRecord,
} from "./adoption-state";
export type {
  AdoptionAuthority,
  AdoptionPhase,
  AdoptionRecord,
} from "./adoption-state";
function request(value: UpdateRequest) {
  assertIdentifier(value.installationId);
  assertIdentifier(value.requestId);
  if (!Number.isSafeInteger(value.expectRevision) || value.expectRevision < 0)
    throw adoptionConflict();
}
/** Read-only SQLite snapshot; status never creates coordination or adoption state. */
export function readAdoption(
  ctx: Ctx,
  installationId: string,
): AdoptionRecord | null {
  assertIdentifier(installationId);
  return (
    listAdoptions(ctx).find((row) => row.installationId === installationId) ??
    null
  );
}
export function listAdoptions(ctx: Ctx): AdoptionRecord[] {
  return adoptionSnapshot(ctx, adoptionRows, []);
}
function adoptionSnapshot<T>(
  ctx: Ctx,
  action: (db: Database) => T,
  empty: T,
): T {
  let dir: string,
    path: string,
    directoryFd: number | undefined,
    fileFd: number | undefined;
  try {
    dir = join(realpathSync(ctx.pacerHome), "desktop-updates");
    path = join(dir, "admission.sqlite");
    if (realpathSync(dir) !== dir) throw adoptionConflict();
    directoryFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    fileFd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const directory = fstatSync(directoryFd),
      file = fstatSync(fileFd);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      directory.mode & 0o077 ||
      !file.isFile() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid?.() ||
      file.mode & 0o077
    )
      throw adoptionConflict();
    const sidecars = () => {
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        try {
          const value = lstatSync(path + suffix);
          if (
            value.isSymbolicLink() ||
            !value.isFile() ||
            value.nlink !== 1 ||
            value.uid !== file.uid ||
            value.mode & 0o077
          )
            throw adoptionConflict();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    };
    sidecars();
    const unchanged = () => {
      sidecars();
      const current = lstatSync(path),
        parent = lstatSync(dir);
      if (
        current.isSymbolicLink() ||
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        current.nlink !== 1 ||
        current.uid !== file.uid ||
        current.mode & 0o077 ||
        parent.isSymbolicLink() ||
        parent.dev !== directory.dev ||
        parent.ino !== directory.ino ||
        parent.uid !== directory.uid ||
        parent.mode & 0o077 ||
        realpathSync(dir) !== dir
      )
        throw adoptionConflict();
    };
    // SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW. Keep the canonical pathname so
    // SQLite observes its original rollback journal; /dev/fd aliases would not.
    const db = new Database(path, 0x01000001);
    try {
      unchanged();
      db.exec(
        "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN",
      );
      const rows = action(db);
      unchanged();
      db.exec("COMMIT");
      return rows;
    } finally {
      db.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" &&
      fileFd === undefined
    )
      return empty;
    throw error;
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
export function beginAdoption(
  ctx: Ctx,
  input: UpdateRequest,
  untrusted: AdoptionAuthority,
): AdoptionRecord {
  request(input);
  const authority = adoptionAuthoritySchema.parse(untrusted);
  if (
    authority.target.id !== input.installationId ||
    resolve(authority.target.pacerHome) !== resolve(ctx.pacerHome)
  )
    throw adoptionConflict();
  const fingerprint = requestFingerprint({
    installationId: authority.target.id,
    oldServiceExecutable: authority.oldServiceExecutable,
    newServiceExecutable: authority.newServiceExecutable,
    expectRevision: String(input.expectRevision),
  });
  return withDesktopCoordinator(ctx, (db) => {
    const rows = adoptionRows(db),
      old = rows.find((row) => row.installationId === input.installationId),
      receipt = old?.receipts.find((r) => r.requestId === input.requestId);
    if (receipt) {
      if (
        receipt.action !== "adopt" ||
        receipt.fingerprint !== fingerprint ||
        receipt.expectRevision !== input.expectRevision
      )
        throw adoptionConflict();
      return adoptionReplay(db, old!, receipt.transactionId);
    }
    assertNoPendingAdoption(db);
    const update = readUpdate(ctx, input.installationId);
    if (
      update.revision !== input.expectRevision ||
      !["idle", "ready", "complete", "restored", "error"].includes(
        update.phase,
      ) ||
      update.revision === Number.MAX_SAFE_INTEGER
    )
      throw adoptionConflict();
    if (
      Math.max(update.revision, old?.revision ?? 0) === Number.MAX_SAFE_INTEGER
    )
      throw adoptionConflict();
    const transactionId = randomUUID();
    return saveAdoption(db, {
      schema: 1,
      installationId: input.installationId,
      revision: Math.max(update.revision, old?.revision ?? 0) + 1,
      transactionId,
      phase: "waiting",
      authority,
      resultingInstallationId: null,
      blockers: [],
      error: null,
      receipts: [
        ...(old?.receipts ?? []),
        {
          requestId: input.requestId,
          action: "adopt",
          fingerprint,
          transactionId,
          expectRevision: input.expectRevision,
        },
      ],
    });
  });
}
export function cancelAdoption(ctx: Ctx, input: UpdateRequest): AdoptionRecord {
  request(input);
  const fingerprint = requestFingerprint({
    expectRevision: String(input.expectRevision),
  });
  return withDesktopCoordinator(ctx, (db) => {
    const value = adoptionRows(db).find(
      (row) => row.installationId === input.installationId,
    );
    if (!value) throw adoptionConflict();
    const receipt = value.receipts.find((r) => r.requestId === input.requestId);
    if (receipt) {
      if (
        receipt.action !== "adoptCancel" ||
        receipt.fingerprint !== fingerprint ||
        receipt.expectRevision !== input.expectRevision
      )
        throw adoptionConflict();
      return adoptionReplay(db, value, receipt.transactionId);
    }
    if (value.revision !== input.expectRevision || value.phase !== "waiting")
      throw adoptionConflict();
    return saveAdoption(db, {
      ...value,
      revision: value.revision + 1,
      phase: "cancelled",
      blockers: [],
      receipts: [
        ...value.receipts,
        {
          requestId: input.requestId,
          action: "adoptCancel",
          fingerprint,
          transactionId: value.transactionId,
          expectRevision: input.expectRevision,
        },
      ],
    });
  });
}
const transitions: Record<AdoptionPhase, readonly AdoptionPhase[]> = {
  waiting: ["reserved", "cancelled"],
  reserved: [
    "installing",
    "verifying",
    "restored",
    "cancelled",
    "recovery-failed",
  ],
  installing: ["verifying", "restored", "recovery-failed"],
  verifying: ["committed", "restored", "recovery-failed"],
  "recovery-failed": ["verifying", "committed", "restored"],
  committed: [],
  restored: [],
  cancelled: [],
};
/** Internal runner CAS. Native effects and admission calls always occur outside this callback. */
export function transitionAdoption(
  ctx: Ctx,
  installationId: string,
  expectRevision: number,
  phase: AdoptionPhase,
  patch: Partial<
    Pick<AdoptionRecord, "resultingInstallationId" | "blockers" | "error">
  > = {},
): AdoptionRecord {
  assertIdentifier(installationId);
  return withDesktopCoordinator(ctx, (db) => {
    const value = adoptionRows(db).find(
      (row) => row.installationId === installationId,
    );
    if (
      !value ||
      value.revision !== expectRevision ||
      !adoptionPending(value) ||
      (!transitions[value.phase].includes(phase) && phase !== value.phase)
    )
      throw adoptionConflict();
    return saveAdoption(db, {
      ...value,
      ...patch,
      phase,
      revision: value.revision + 1,
    });
  });
}

/** Read-only replay survives an ownership-ID transition and grants no new native permission. */
export function replayAdoptionRequest(
  ctx: Ctx,
  input: UpdateRequest,
  action: "adopt" | "adoptCancel" = "adopt",
): AdoptionRecord | null {
  request(input);
  return adoptionSnapshot(
    ctx,
    (db) => {
      const current = adoptionRows(db).find(
          (row) => row.installationId === input.installationId,
        ),
        receipt = current?.receipts.find(
          (r) => r.requestId === input.requestId,
        );
      if (!receipt) return null;
      if (
        receipt.action !== action ||
        receipt.expectRevision !== input.expectRevision
      )
        throw adoptionConflict();
      return adoptionReplay(db, current!, receipt.transactionId);
    },
    null,
  );
}

/** Terminal cleanup may read an immutable prior row image, but cannot resume it. */
export function readTerminalAdoption(
  ctx: Ctx,
  installationId: string,
  transactionId: string,
): AdoptionRecord | null {
  assertIdentifier(installationId);
  assertIdentifier(transactionId);
  return adoptionSnapshot(
    ctx,
    (db) => {
      const current = adoptionRows(db).find(
        (row) => row.installationId === installationId,
      );
      if (!current) return null;
      const value = adoptionReplay(db, current, transactionId);
      if (!["committed", "restored"].includes(value.phase))
        throw adoptionConflict();
      return value;
    },
    null,
  );
}
