import { beginWorkSync, claimWorkSync, finishWorkSync } from "../update/desktop/admission";
import { ownProcessIdentity, sameProcess } from "../update/desktop/process-identity";
import { currentVersion } from "../update/version";
import { readTask, updateTask, withTaskLock } from "./store";
import type { RunRef } from "./types";
import type { Ctx } from "../types";

export const HANDOVER_PROTOCOL = 1;
export const HANDOVER_SIGNAL = "SIGUSR2" as const;

let runnerLease: string | undefined;
let attemptLease: string | undefined;
let advertised: { taskId: string; dir: string } | undefined;
let requested = false;
let installed = false;

/** The runner's own task lease; the commit point finishes it. */
export function registerRunnerLease(lease: string): void { runnerLease = lease; }

/** The per-attempt operation lease, kept reachable so the commit point can finish it before exiting. */
export async function withAttemptWork<T>(ctx: Ctx, taskId: string, action: () => Promise<T>): Promise<T> {
  const lease = beginWorkSync(ctx, { kind: "operation", id: taskId, label: "Executor attempt" });
  claimWorkSync(ctx, lease);
  attemptLease = lease;
  try { return await action(); }
  finally { if (attemptLease === lease) attemptLease = undefined; finishWorkSync(ctx, lease); }
}

/** Install before any work: Bun's default SIGUSR2 action terminates the process. */
export function installHandoverHandler(): void {
  if (installed) return;
  installed = true;
  process.on(HANDOVER_SIGNAL, () => { if (advertised) requested = true; });
}

export function handoverRequested(): boolean { return requested; }

/** Publish eligibility: this runner supervises a live attempt whose run is recorded in `t.run`. */
export function advertiseHandover(ctx: Ctx, taskId: string, run: RunRef): boolean {
  const identity = ownProcessIdentity();
  const current = readTask(ctx, taskId);
  if (!identity || !current || current.state !== "running" || current.runnerPid !== process.pid || current.run?.dir !== run.dir) return false;
  const t = updateTask(ctx, taskId, x => {
    if (x.state !== "running" || x.runnerPid !== process.pid || x.run?.dir !== run.dir) return;
    x.handover = { protocol: HANDOVER_PROTOCOL, pacer: currentVersion(), identity };
  });
  const ok = !!t.handover && t.handover.state === undefined && sameProcess(t.handover.identity, identity);
  advertised = ok ? { taskId, dir: run.dir } : undefined;
  return ok;
}

/** Leave the eligible state: drop this runner's own advertisement and any pending request. */
export function withdrawHandover(ctx: Ctx, taskId: string): void {
  advertised = undefined; requested = false;
  const identity = ownProcessIdentity();
  const own = readTask(ctx, taskId)?.handover;
  if (!identity || !own || own.state !== undefined || !sameProcess(own.identity, identity)) return;
  updateTask(ctx, taskId, x => {
    if (x.handover && x.handover.state === undefined && sameProcess(x.handover.identity, identity)) delete x.handover;
  });
}

/** Forget module state between in-process runner tests. */
export function resetHandoverState(): void {
  runnerLease = undefined; attemptLease = undefined; advertised = undefined; requested = false;
}

export type HandoverOutcome = "none" | "declined" | "committed";

/**
 * Commit point, called at a poll boundary while the run is alive. Inside the task lock it re-checks
 * eligibility (still running, same t.run, no stop requested, this runner's own advertisement), finishes
 * this runner's task and attempt leases and marks the handover. It never releases dispatch, revokes work
 * grants or enforcement tokens, drains the queue or records an attempt outcome. The run stays covered by
 * its session lease and run-directory evidence. After the lock is released, the runner exits 0.
 */
export function commitHandoverIfRequested(ctx: Ctx, taskId: string, run: RunRef, exit: (code: number) => never = code => process.exit(code)): HandoverOutcome {
  if (!requested || advertised?.taskId !== taskId || advertised.dir !== run.dir) return "none";
  requested = false;
  const identity = ownProcessIdentity();
  const outcome = withTaskLock(ctx, taskId, (): HandoverOutcome => {
    const t = readTask(ctx, taskId);
    const eligible = !!t && !!identity && t.state === "running" && t.runnerPid === process.pid
      && t.run?.dir === run.dir && t.run.attempt === run.attempt && t.run.attempt > t.attempts.length
      && !!t.handover && t.handover.state === undefined && sameProcess(t.handover.identity, identity);
    if (!eligible) {
      if (t?.handover && t.handover.state === undefined) updateTask(ctx, taskId, x => { if (x.handover && x.handover.state === undefined) x.handover.declinedAt = Date.now() / 1000; });
      return "declined";
    }
    if (attemptLease) finishWorkSync(ctx, attemptLease);
    if (runnerLease) finishWorkSync(ctx, runnerLease);
    attemptLease = undefined; runnerLease = undefined;
    updateTask(ctx, taskId, x => {
      x.handover = { ...x.handover!, state: "handed-over", committedAt: Date.now() / 1000 };
      delete x.runnerPid;
    });
    return "committed";
  });
  if (outcome === "committed") { advertised = undefined; exit(0); }
  return outcome;
}
