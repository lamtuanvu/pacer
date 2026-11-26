import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../../types";
import { CoreError } from "../../core/errors";
import { compareVersions } from "../version";
import { assertIdentifier, type Blocker } from "./types";
import { withDesktopCoordinator } from "./coordinator";
import { optionalFence } from "./reconciliation-fence";
import type { Database } from "bun:sqlite";
import { ownProcessIdentity, processIdentity, sameProcess } from "./process-identity";

import { OrcaClient, type OrcaReply, type WorkerClosureResult } from "../../exec/orca/client";
import { workerClosureProof, terminalClosureProof } from "./orca-proof";
import { externalBlockers, storedBlockers, runFinished } from "./blockers";

const incarnation = randomUUID();
const identitySchema = z.object({ pid: z.number().int().positive(), bootId: z.string().min(1), birth: z.string().min(1) });
const blockerSchema = z.object({ kind: z.enum(["task", "session", "launch", "operation"]), id: z.string().min(1), label: z.string() });
const leaseSchema = z.object({ id: z.string().uuid(), blocker: blockerSchema, owner: z.string().uuid(), process: identitySchema.nullable(), state: z.enum(["pending", "active"]), runDir: z.string().optional(), remote: z.object({ host: z.string(), dir: z.string() }).optional(), launched: z.boolean().optional(), orca: z.object({ dispatchId: z.string(), terminal: z.string().nullable(), incarnationId: z.string().optional() }).optional(), class: z.literal("survivor").optional() });
// `survivors: true` marks a reservation admitted while survivor leases ran (ADR 2026-11-25).
// Older services and helpers strip or refuse it; both fall back to waiting.
const stateSchema = z.object({ schema: z.literal(1), reservation: z.string().nullable(), leases: z.array(leaseSchema), survivors: z.literal(true).optional() });
type AdmissionState = z.infer<typeof stateSchema>;

// The fence marker witnesses this row once initialized. Legacy admission is
// migrated in the same transaction; a present table without its row is ambiguous.
export function ensureAdmission(db: Database, allowCreate: boolean): AdmissionState {
  const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='admission'").get();
  if (!table) {
    if (!allowCreate) throw new CoreError("conflict", "Desktop admission evidence is unavailable");
    db.exec("CREATE TABLE admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)");
    db.query("INSERT INTO admission (id, state) VALUES (1, ?)").run(JSON.stringify({ schema: 1, reservation: null, leases: [] }));
  }
  const row = db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get();
  try { if (row) return stateSchema.parse(JSON.parse(row.state)); }
  catch { /* Retain invalid evidence for recovery. */ }
  throw new CoreError("conflict", "Desktop admission evidence is unavailable");
}
function mutate<T>(ctx: Ctx, action: (state: AdmissionState, db: Database) => T): T {
  return withDesktopCoordinator(ctx, db => {
    const fence = optionalFence(db);
    const state = ensureAdmission(db, fence === null);
    reconcileStored(state);
    const result = action(state, db);
    db.query("UPDATE admission SET state = ? WHERE id = 1").run(JSON.stringify(state));
    return result;
  });
}

/** Persist before any side effect. A pending lease cannot be reclaimed by age or parent death. */
export function beginWorkSync(ctx: Ctx, blocker: Blocker): string {
  const parsed = blockerSchema.safeParse(blocker);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid desktop work blocker");
  const identity = ownProcessIdentity();
  return mutate(ctx, (state, db) => {
    if (state.reservation || optionalFence(db)?.transaction) throw new CoreError("conflict", "Desktop update maintenance is reserved", "Wait for the update to finish or cancel the pending update.");
    const id = randomUUID();
    state.leases.push({ id, blocker: parsed.data, owner: incarnation, process: identity, state: "pending" });
    return id;
  });
}
export async function beginWork(ctx: Ctx, blocker: Blocker): Promise<string> { return beginWorkSync(ctx, blocker); }

/** A private unguessable lease is passed to exactly one child, which claims before starting work. */
export function claimWorkSync(ctx: Ctx, leaseId: string): boolean {
  const identity = ownProcessIdentity();
  return mutate(ctx, (state, db) => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || (lease.state === "active" && lease.owner !== incarnation)) {
      throw new CoreError("conflict", "Desktop work lease has no claimable owner");
    }
    // Reservations cannot coexist with leases; treat inconsistent state as unsafe.
    if (state.reservation || optionalFence(db)?.transaction) throw new CoreError("conflict", "Desktop update maintenance is reserved");
    const newlyClaimed=lease.state!=="active";
    lease.owner = incarnation; lease.process = identity; lease.state = "active";
    return newlyClaimed;
  });
}

/** Call only after work actually ended, or before any external side effect occurred. */
export function finishWorkSync(ctx: Ctx, leaseId: string): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease) return;
    if (lease.owner !== incarnation) throw new CoreError("conflict", "Desktop work lease owner changed");
    state.leases = state.leases.filter(item => item.id !== leaseId);
  });
}
export async function finishWork(ctx: Ctx, leaseId: string): Promise<void> { finishWorkSync(ctx, leaseId); }

/**
 * Reserve the swap. With `survivors` (every party declared support, see `survivorSupport`),
 * survivor leases and the stored work they cover do not block; the native helper verifies
 * each survivor process before it installs. Every other lease, start and stored record blocks.
 */
export async function reserveIdle(ctx: Ctx, transactionId: string, options: { survivors?: boolean } = {}): Promise<{ reserved: boolean; blockers: Blocker[] }> {
  assertIdentifier(transactionId);
  await reconcileAdmission(ctx);
  const external = await externalBlockers(ctx);
  return mutate(ctx, (state, db) => {
    pruneDeadLocalLeases(state);
    if (optionalFence(db)?.transaction) throw new CoreError("conflict", "Reconciliation maintenance is reserved");
    if (state.reservation && state.reservation !== transactionId) throw new CoreError("conflict", "Desktop reservation conflict");
    const survivors = options.survivors ? state.leases.filter(survivorLease) : [];
    const blockers = [
      ...state.leases.filter(lease => !survivors.includes(lease)).map(lease => lease.blocker),
      ...storedBlockers(ctx).filter(blocker => !coveredBySurvivor(ctx, blocker, survivors)),
      ...external,
    ];
    if (blockers.length) return { reserved: false, blockers };
    state.reservation = transactionId;
    if (survivors.length) state.survivors = true; else delete state.survivors;
    return { reserved: true, blockers: [] };
  });
}

type Lease = z.infer<typeof leaseSchema>;
/** A claimed local lease of a handover-capable process; Orca and remote work never survive. */
function survivorLease(lease: Lease): boolean {
  return lease.class === "survivor" && !!lease.process && !lease.orca && !lease.remote;
}
/** A stored running task or unfinished run is covered when a survivor lease owns it. */
function coveredBySurvivor(ctx: Ctx, blocker: Blocker, survivors: readonly Lease[]): boolean {
  if (!survivors.length) return false;
  const runs = resolve(ctx.pacerHome, "runs");
  const runOf = (lease: Lease) => lease.runDir ? relative(runs, resolve(lease.runDir)).split(sep) : null;
  if (blocker.kind === "session") {
    const [task, attempt] = blocker.id.split("/");
    return survivors.some(lease => { const run = runOf(lease); return !!run && run.length === 2 && run[0] === task && run[1] === attempt; });
  }
  if (blocker.kind === "task") {
    return survivors.some(lease => (lease.blocker.kind === "task" && lease.blocker.id === blocker.id)
      || (() => { const run = runOf(lease); return !!run && run.length === 2 && run[0] === blocker.id; })());
  }
  return false;
}

/** First version whose service, helper and rollback path understand survivor leases. */
export const SURVIVOR_LEASES_SINCE = "0.18.7";
/**
 * ADR point 3: survivors only when the installed helper and rollback target (the installed
 * bundle), this service and the update target all declare support. Otherwise wait for idle.
 */
export function survivorSupport(installed: string, target: string | undefined): boolean {
  try {
    return !!target && compareVersions(installed, SURVIVOR_LEASES_SINCE) >= 0 && compareVersions(target, SURVIVOR_LEASES_SINCE) >= 0;
  } catch { return false; }
}

/**
 * Mark this incarnation's claimed lease as a survivor: its process speaks the handover protocol
 * (or is a session host) and keeps running across a desktop update. The class is never cleared;
 * the process stays handover-capable until it finishes its lease.
 */
export function markSurvivorSync(ctx: Ctx, leaseId: string): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.owner !== incarnation || !lease.process || lease.orca || lease.remote) return;
    lease.class = "survivor";
  });
}
/** Mark this incarnation's leases bound to `runDir` (the run a runner advertised for handover). */
export function markRunSurvivorsSync(ctx: Ctx, runDir: string): void {
  const dir = resolve(runDir);
  mutate(ctx, state => {
    for (const lease of state.leases) {
      if (lease.owner === incarnation && lease.runDir && resolve(lease.runDir) === dir && lease.process && !lease.orca && !lease.remote) lease.class = "survivor";
    }
  });
}
/** A refusal because an update holds the reservation; callers that may wait can retry. */
export function maintenanceReserved(error: unknown): boolean {
  return error instanceof CoreError && error.code === "conflict" && error.message === "Desktop update maintenance is reserved";
}
/** Read-only transaction authority check. Never acquires a work lease or reservation. */
export function hasReservation(ctx: Ctx, transactionId: string): boolean {
  assertIdentifier(transactionId);
  return withDesktopCoordinator(ctx, db => {
    const table = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='admission'").get();
    if (!table) return false;
    const row = db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get();
    if (!row) return false;
    try { return stateSchema.parse(JSON.parse(row.state)).reservation === transactionId; }
    catch { throw new CoreError("not_allowed", "Desktop admission authority could not be verified"); }
  });
}

/** Private native coverage projection; these incarnations have durable work leases. */
export function enrolledWorkProcesses(ctx: Ctx): import("./process-identity").ProcessIdentity[] {
  return mutate(ctx, state => {
    pruneDeadLocalLeases(state);
    return state.leases.flatMap(lease => lease.process ? [lease.process] : []);
  });
}

export async function releaseReservation(ctx: Ctx, transactionId: string): Promise<void> {
  assertIdentifier(transactionId);
  mutate(ctx, state => {
    if (state.reservation && state.reservation !== transactionId) throw new CoreError("conflict", "Desktop reservation conflict");
    state.reservation = null;
    delete state.survivors;
  });
}

/**
 * Crash recovery deliberately keeps ambiguous leases and update reservations.
 * Remote and Orca leases still need positive completion evidence. Local leases
 * are not ambiguous when their process cannot survive the current boot: a
 * different bootId, a missing runDir, a dead owner with no live runDir child,
 * or a dead owner without runDir evidence.
 */
export async function reconcileAdmission(ctx: Ctx): Promise<void> {
  const leases = mutate(ctx, state => {
    pruneDeadLocalLeases(state);
    return state.leases.filter(lease => lease.orca?.terminal && lease.orca.incarnationId);
  });
  const client = new OrcaClient(ctx.run, ctx.env);
  for (const lease of leases) {
    const binding = lease.orca!;
    try {
      const reply = await client.terminalShow(binding.terminal!);
      if (terminalClosureProof(reply, binding.terminal!, binding.incarnationId)) {
        mutate(ctx, state => { state.leases = state.leases.filter(item => item.id !== lease.id); });
      }
    } catch { /* Failed/ambiguous lookup retains the blocker. */ }
  }
}

/** True when a runDir pid/child file names a process still alive on `bootId`. */
function runDirHasLiveLocalProcess(runDir: string, bootId: string): boolean {
  for (const name of ["child", "pid"] as const) {
    try {
      const pid = Number(readFileSync(join(runDir, name), "utf8").trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      const live = processIdentity(pid);
      if (live && live.bootId === bootId) return true;
    } catch { /* missing or unreadable evidence */ }
  }
  return false;
}

/**
 * True when the lease's recorded local process cannot still be that incarnation.
 * Remote and Orca leases are never pruned here. Local rule (see docs/desktop-updates.md):
 * - bootId ≠ current boot → dead (local processes never survive reboot);
 * - runDir path gone → dead;
 * - same boot, unfinished runDir, owner dead/reused → keep only if child/pid is live;
 * - otherwise dead when owner pid is gone or reused.
 */
export function localLeaseProcessDead(
  lease: Pick<z.infer<typeof leaseSchema>, "process" | "remote" | "orca" | "runDir">,
): boolean {
  if (!lease.process || lease.remote || lease.orca) return false;
  const currentBoot = ownProcessIdentity()?.bootId ?? processIdentity(process.pid)?.bootId ?? null;
  // Local processes, including detached children, never survive a reboot.
  if (currentBoot && lease.process.bootId !== currentBoot) return true;
  if (lease.runDir) {
    if (!existsSync(lease.runDir)) return true;
    if (!runFinished(lease.runDir)) {
      const owner = processIdentity(lease.process.pid);
      if (owner && sameProcess(owner, lease.process)) return false;
      // Owner gone or reused: keep only when runDir still names a live child/session.
      return !runDirHasLiveLocalProcess(lease.runDir, lease.process.bootId);
    }
  }
  const live = processIdentity(lease.process.pid);
  if (!live) return true;
  if (live.bootId !== lease.process.bootId) return true;
  return !sameProcess(live, lease.process);
}

/** Change presentation metadata after a pre-admitted operation allocates its entity. */
export function describeWorkSync(ctx: Ctx, leaseId: string, blocker: Blocker): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.owner !== incarnation) throw new CoreError("conflict", "Desktop work lease owner changed");
    lease.blocker = blockerSchema.parse(blocker);
  });
}

export function withWorkSync<T>(ctx: Ctx, blocker: Blocker, action: () => T): T {
  const lease = beginWorkSync(ctx, blocker); claimWorkSync(ctx, lease);
  try { return action(); } finally { finishWorkSync(ctx, lease); }
}
export async function withWork<T>(ctx: Ctx, blocker: Blocker, action: () => Promise<T>): Promise<T> {
  const lease = beginWorkSync(ctx, blocker); claimWorkSync(ctx, lease);
  try { return await action(); } finally { finishWorkSync(ctx, lease); }
}
export function reconcileAdmissionSync(ctx: Ctx): void { mutate(ctx, () => {}); }

export function validatePendingWorkSync(ctx: Ctx, leaseId: string): void {
  mutate(ctx, (state, db) => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.state !== "pending" || lease.owner !== incarnation || state.reservation || optionalFence(db)?.transaction) {
      throw new CoreError("conflict", "Desktop work lease has no pending owner");
    }
  });
}

/** Bind a unique launch to the run's completion receipt, not to PID liveness. */
export function attachRunEvidenceSync(ctx: Ctx, leaseId: string, dir: string, remote?: { host: string; dir: string }): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.owner !== incarnation) throw new CoreError("conflict", "Desktop work lease owner changed");
    lease.runDir = dir;
    if (remote) lease.remote = remote;
  });
}
function pruneDeadLocalLeases(state: AdmissionState): void {
  state.leases = state.leases.filter(lease => !localLeaseProcessDead(lease));
}

function reconcileStored(state: AdmissionState): void {
  // Dead local process pruning runs in reconcileAdmission / reserveIdle / enrolled
  // projection, not on every mutate, so ownership checks still see a just-exited child.
  state.leases = state.leases.filter(lease => {
    if (!lease.runDir || !runFinished(lease.runDir)) return true;
    try {
      return readFileSync(join(lease.runDir, "admission.complete"), "utf8").trim() !== lease.id;
    } catch { return true; }
  });
}

export function markLaunchStartedSync(ctx: Ctx, leaseId: string): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.owner !== incarnation || lease.state !== "pending") throw new CoreError("conflict", "Desktop work lease owner changed");
    lease.launched = true;
  });
}
/** Release an unused preallocation; never release a child handoff or uncertain spawn. */
export function finishUnlaunchedWorkSync(ctx: Ctx, leaseId: string): void {
  mutate(ctx, state => { state.leases = state.leases.filter(lease => lease.id !== leaseId || lease.owner !== incarnation || lease.launched || lease.state !== "pending"); });
}

export function bindOrcaWorkSync(ctx: Ctx, leaseId: string, binding: { dispatchId: string; terminal: string | null; incarnationId?: string }): void {
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.owner !== incarnation) throw new CoreError("conflict", "Desktop work lease owner changed");
    lease.orca = binding;
  });
}
/**
 * Release leases bound to an Orca terminal the caller proved dead by its own action (for example,
 * pacer removed the terminal's worktree). A lease bound to another incarnation stays.
 */
export function releaseOrcaTerminalWorkSync(ctx: Ctx, terminal: string, incarnationId?: string): number {
  return mutate(ctx, state => {
    const before = state.leases.length;
    state.leases = state.leases.filter(lease => lease.orca?.terminal !== terminal
      || (lease.orca.incarnationId !== undefined && lease.orca.incarnationId !== incarnationId));
    return before - state.leases.length;
  });
}
export function finishOrcaWorkSync(ctx: Ctx, leaseId: string, proof: OrcaReply<WorkerClosureResult>): boolean {
  return mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease?.orca || !workerClosureProof(proof, lease.orca.dispatchId, lease.orca.terminal)) return false;
    state.leases = state.leases.filter(item => item.id !== leaseId);
    return true;
  });
}

/** Called only inside the coordinator transaction before acquiring the fence. */
export function assertReconciliationIdle(db: Database, ctx: Ctx): void {
  const state = ensureAdmission(db, false);
  reconcileStored(state);
  if (state.reservation || state.leases.length) throw new CoreError("conflict", "Desktop work is active or reserved");
  if (storedBlockers(ctx).length) throw new CoreError("conflict", "Stored work blocks reconciliation");
}
