import { compareVersions, currentVersion } from "../update/version";
import { signalSameProcess, type ProcessIdentity } from "../update/desktop/process-identity";
import { runningWork, workCounts } from "../service/running-work";
import { listTasksWhere, readTask, updateTask } from "./store";
import { HANDOVER_PROTOCOL, HANDOVER_SIGNAL } from "./handover";
import type { TaskRecord } from "./types";
import type { Ctx } from "../types";

export interface HandoverReport { pacer: string; tasks: number; sessions: number; handedOver: number; keptOnPreviousRunner: number; summary: string }
export interface HandoverDeps { waitMs?: number; pollMs?: number; signal?: (identity: ProcessIdentity, signal: NodeJS.Signals) => boolean; sleep?: (ms: number) => Promise<void> }

const MAX_WAIT_MS = 60_000;
const olderThan = (version: string, current: string) => { try { return compareVersions(version, current) < 0; } catch { return false; } };
const fresh = (ctx: Ctx): Ctx => ({ ...ctx, now: Date.now() / 1000 });

/** Runners that advertised a protocol this service speaks, from an older pacer, and that still own their task. */
export function handoverCandidates(ctx: Ctx, current = currentVersion()): TaskRecord[] {
  return listTasksWhere(ctx, { states: ["running"] }).filter(t => !!t.handover && t.handover.state === undefined
    && t.handover.protocol === HANDOVER_PROTOCOL && olderThan(t.handover.pacer, current)
    && t.runnerPid !== undefined && t.handover.identity.pid === t.runnerPid);
}

export function upgradeSummary(prefix: string, r: { tasks: number; sessions: number; keptOnPreviousRunner: number }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${prefix} ${plural(r.tasks, "task")} and ${plural(r.sessions, "session")} kept running; ${r.keptOnPreviousRunner} stayed on the previous runner.`;
}

/**
 * Ask eligible older runners to hand over, wait up to 60 s for each to commit or decline, then count.
 * Only upgrade paths call this (CLI after its health check, update.apply recovery); plain start-up never does.
 */
export async function triggerHandover(ctx: Ctx, deps: HandoverDeps = {}): Promise<HandoverReport> {
  const current = currentVersion(), signal = deps.signal ?? signalSameProcess, sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const waitMs = Math.min(deps.waitMs ?? MAX_WAIT_MS, MAX_WAIT_MS), pollMs = deps.pollMs ?? 250;
  const signalled = new Map<string, { pid: number; at: number }>();
  for (const candidate of handoverCandidates(ctx, current)) {
    const t = readTask(ctx, candidate.id); // Re-check right before signalling.
    if (!t?.handover || t.handover.state !== undefined || t.runnerPid === undefined || t.runnerPid !== t.handover.identity.pid) continue;
    const at = Date.now() / 1000, pid = t.runnerPid, identity = t.handover.identity;
    updateTask(fresh(ctx), t.id, x => { if (x.handover && x.handover.state === undefined) x.handover.signalledAt = at; });
    if (signal(identity, HANDOVER_SIGNAL)) signalled.set(t.id, { pid, at });
  }
  const committed = new Set<string>();
  const settled = (id: string): boolean => {
    const t = readTask(ctx, id), s = signalled.get(id)!;
    if (!t) return true;
    if (t.handover?.state === "handed-over" || (t.runnerPid !== undefined && t.runnerPid !== s.pid && t.runnerPacer === current)) { committed.add(id); return true; }
    if ((t.handover?.declinedAt ?? 0) >= s.at || t.state !== "running" || t.runnerPid === undefined) return true;
    return false;
  };
  const deadline = Date.now() + waitMs;
  while ([...signalled.keys()].some(id => !settled(id)) && Date.now() < deadline) await sleep(pollMs);
  for (const id of signalled.keys()) settled(id);
  const work = await runningWork(ctx, current);
  const counts = workCounts(work);
  const kept = work.tasks.filter(t => t.older && !committed.has(t.taskId)).length;
  const report = { pacer: current, tasks: counts.tasks, sessions: counts.sessions, handedOver: committed.size, keptOnPreviousRunner: kept };
  return { ...report, summary: upgradeSummary(`Updated to v${current}.`, report) };
}
