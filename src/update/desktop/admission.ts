import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Ctx } from "../../types";
import { CoreError } from "../../core/errors";
import { assertIdentifier, type Blocker } from "./types";
import { withDesktopCoordinator } from "./coordinator";
import { ownProcessIdentity } from "./process-identity";

import { OrcaClient, type OrcaReply, type WorkerClosureResult } from "../../exec/orca/client";
import { workerClosureProof, terminalClosureProof } from "./orca-proof";
import { externalBlockers, storedBlockers, runFinished } from "./blockers";

const incarnation = randomUUID();
const identitySchema = z.object({ pid: z.number().int().positive(), bootId: z.string().min(1), birth: z.string().min(1) });
const blockerSchema = z.object({ kind: z.enum(["task", "session", "launch", "operation"]), id: z.string().min(1), label: z.string() });
const leaseSchema = z.object({ id: z.string().uuid(), blocker: blockerSchema, owner: z.string().uuid(), process: identitySchema.nullable(), state: z.enum(["pending", "active"]), runDir: z.string().optional(), remote: z.object({ host: z.string(), dir: z.string() }).optional(), launched: z.boolean().optional(), orca: z.object({ dispatchId: z.string(), terminal: z.string().nullable(), incarnationId: z.string().optional() }).optional() });
const stateSchema = z.object({ schema: z.literal(1), reservation: z.string().nullable(), leases: z.array(leaseSchema) });
type AdmissionState = z.infer<typeof stateSchema>;

function mutate<T>(ctx: Ctx, action: (state: AdmissionState) => T): T {
  return withDesktopCoordinator(ctx, db => {
    db.exec("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)");
    const row = db.query<{ state: string }, []>("SELECT state FROM admission WHERE id = 1").get();
    let state: AdmissionState;
    try { state = row ? stateSchema.parse(JSON.parse(row.state)) : { schema: 1, reservation: null, leases: [] }; }
    catch { throw new CoreError("invalid_input", "Invalid desktop admission state", "Retain the state for recovery; do not reset pending work."); }
    reconcileStored(state);
    const result = action(state);
    db.query("INSERT INTO admission (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(JSON.stringify(state));
    return result;
  });
}

/** Persist before any side effect. A pending lease cannot be reclaimed by age or parent death. */
export function beginWorkSync(ctx: Ctx, blocker: Blocker): string {
  const parsed = blockerSchema.safeParse(blocker);
  if (!parsed.success) throw new CoreError("invalid_input", "Invalid desktop work blocker");
  const identity = ownProcessIdentity();
  return mutate(ctx, state => {
    if (state.reservation) throw new CoreError("conflict", "Desktop update maintenance is reserved", "Wait for the update to finish or cancel the pending update.");
    const id = randomUUID();
    state.leases.push({ id, blocker: parsed.data, owner: incarnation, process: identity, state: "pending" });
    return id;
  });
}
export async function beginWork(ctx: Ctx, blocker: Blocker): Promise<string> { return beginWorkSync(ctx, blocker); }

/** A private unguessable lease is passed to exactly one child, which claims before starting work. */
export function claimWorkSync(ctx: Ctx, leaseId: string): void {
  const identity = ownProcessIdentity();
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || (lease.state === "active" && lease.owner !== incarnation)) {
      throw new CoreError("conflict", "Desktop work lease has no claimable owner");
    }
    // Reservations cannot coexist with leases; treat inconsistent state as unsafe.
    if (state.reservation) throw new CoreError("conflict", "Desktop update maintenance is reserved");
    lease.owner = incarnation; lease.process = identity; lease.state = "active";
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

export async function reserveIdle(ctx: Ctx, transactionId: string): Promise<{ reserved: boolean; blockers: Blocker[] }> {
  assertIdentifier(transactionId);
  await reconcileAdmission(ctx);
  const external = await externalBlockers(ctx);
  return mutate(ctx, state => {
    if (state.reservation && state.reservation !== transactionId) throw new CoreError("conflict", "Desktop reservation conflict");
    const blockers = [...state.leases.map(lease => lease.blocker), ...storedBlockers(ctx), ...external];
    if (blockers.length) return { reserved: false, blockers };
    state.reservation = transactionId;
    return { reserved: true, blockers: [] };
  });
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
  return withDesktopCoordinator(ctx, db => {
    if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='admission'").get()) return [];
    const row = db.query<{state:string}, []>("SELECT state FROM admission WHERE id=1").get();
    if (!row) return [];
    const state = stateSchema.parse(JSON.parse(row.state));
    return state.leases.flatMap(lease => lease.process ? [lease.process] : []);
  });
}

export async function releaseReservation(ctx: Ctx, transactionId: string): Promise<void> {
  assertIdentifier(transactionId);
  mutate(ctx, state => {
    if (state.reservation && state.reservation !== transactionId) throw new CoreError("conflict", "Desktop reservation conflict");
    state.reservation = null;
  });
}

/**
 * Crash recovery deliberately keeps ambiguous leases and update reservations.
 * Owner death does not prove a detached/remote child finished. Runtime adapters
 * must supply positive completion evidence before clearing orphaned work.
 */
export async function reconcileAdmission(ctx: Ctx): Promise<void> {
  const leases = mutate(ctx, state => state.leases.filter(lease => lease.orca?.terminal && lease.orca.incarnationId));
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
  mutate(ctx, state => {
    const lease = state.leases.find(item => item.id === leaseId);
    if (!lease || lease.state !== "pending" || lease.owner !== incarnation || state.reservation) {
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
function reconcileStored(state: AdmissionState): void {
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
