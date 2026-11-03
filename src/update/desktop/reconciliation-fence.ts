import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertReconciliationIdle, ensureAdmission } from "./admission";
import type { Ctx } from "../../types";
import { CoreError } from "../../core/errors";
import { withDesktopCoordinator } from "./coordinator";
import { ownProcessIdentity, sameProcess } from "./process-identity";
import type { Database } from "bun:sqlite";

// Admission fence only; unknown writers and coordinator authentication remain unproven.
// It must not be used to authorize native effects.
const rowSchema = z.object({ epoch: z.number().int().nonnegative().safe(), transaction_id: z.string().min(1).nullable(), pid: z.number().int().positive().nullable(), boot_id: z.string().min(1).nullable(), birth: z.string().min(1).nullable() }).refine(row => row.transaction_id === null ? row.pid === null && row.boot_id === null && row.birth === null : row.pid !== null && row.boot_id !== null && row.birth !== null);
export type FenceSnapshot = { epoch: number; transaction: string | null; owner: { pid: number; bootId: string; birth: string } | null };
function conflict(): never { throw new CoreError("conflict", "Reconciliation fence conflict or unavailable identity"); }
// The coordinator transaction serializes the marker and fence creation. Total
// database loss cannot be detected without evidence outside that database.
export function optionalFence(db: Database, initialize = false): FenceSnapshot | null {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
  const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='reconciliation_fence'").get();
  if (version === 0) {
    // This fence has never shipped: any unversioned table is ambiguous.
    if (table) return conflict();
    if (!initialize) return null;
    ensureAdmission(db, true);
    db.exec("CREATE TABLE reconciliation_fence (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL, transaction_id TEXT, pid INTEGER, boot_id TEXT, birth TEXT)");
    db.exec("INSERT INTO reconciliation_fence (id, epoch) VALUES (1, 0)");
    db.exec("PRAGMA user_version = 1");
  } else if (version !== 1 || !table) return conflict();
  const parsed = rowSchema.safeParse(db.query("SELECT epoch, transaction_id, pid, boot_id, birth FROM reconciliation_fence WHERE id = 1").get());
  if (!parsed.success) return conflict();
  const r = parsed.data;
  return { epoch: r.epoch, transaction: r.transaction_id, owner: r.pid !== null && r.boot_id !== null && r.birth !== null ? { pid: r.pid, bootId: r.boot_id, birth: r.birth } : null };
}
export function loadFence(db: Database): FenceSnapshot {
  return optionalFence(db, true)!;
}
export function readFence(ctx: Ctx): FenceSnapshot { return withDesktopCoordinator(ctx, loadFence); }
export function reserveFence(ctx: Ctx, epoch: number, transaction: string): FenceSnapshot {
  const identity = ownProcessIdentity();
  if (!identity || !transaction || !Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER) return conflict();
  return withDesktopCoordinator(ctx, db => {
    const state = loadFence(db);
    assertReconciliationIdle(db, ctx);
    // Orca state requires asynchronous inspection and cannot be proved idle here.
    if (existsSync(join(ctx.pacerHome, "orca.json"))) return conflict();
    if (state.epoch !== epoch || state.transaction !== null) return conflict();
    const result = db.query("UPDATE reconciliation_fence SET epoch = epoch + 1, transaction_id = ?, pid = ?, boot_id = ?, birth = ? WHERE id = 1 AND epoch = ? AND transaction_id IS NULL").run(transaction, identity.pid, identity.bootId, identity.birth, epoch);
    if (result.changes !== 1) return conflict();
    return loadFence(db);
  });
}
export function releaseFence(ctx: Ctx, snapshot: FenceSnapshot): FenceSnapshot {
  const identity = ownProcessIdentity();
  if (!identity || !sameProcess(identity, snapshot.owner) || !snapshot.transaction || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch >= Number.MAX_SAFE_INTEGER) return conflict();
  return withDesktopCoordinator(ctx, db => {
    const state = loadFence(db);
    if (state.epoch !== snapshot.epoch || state.transaction !== snapshot.transaction || !sameProcess(state.owner, identity)) return conflict();
    const result = db.query("UPDATE reconciliation_fence SET epoch = epoch + 1, transaction_id = NULL, pid = NULL, boot_id = NULL, birth = NULL WHERE id = 1 AND epoch = ? AND transaction_id = ? AND pid = ? AND boot_id = ? AND birth = ?").run(snapshot.epoch, snapshot.transaction, identity.pid, identity.bootId, identity.birth);
    if (result.changes !== 1) return conflict();
    return loadFence(db);
  });
}
