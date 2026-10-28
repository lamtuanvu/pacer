import { existsSync } from "node:fs";
import { worktreeDirty } from "../../supervisor/worktree";
import { releaseOrcaTerminalWorkSync } from "../../update/desktop/admission";
import { listTasksWhere, updateTask } from "../../tasks/store";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import type { HostClean, HostCleanOpts } from "../cleanup";
import { OrcaClient, type TerminalRow } from "./client";
import { realpathSafe } from "./setup";
import { loadOrcaState, type StrandedWorktree, type StrayRisk, type UncertainStart, updateOrcaState, withLock } from "./state";

export interface OwnedWorktree { id: string; path: string; name: string }
export interface CleanupDeps { sleep: (ms: number) => Promise<void>; polls: number }
const SETTLED = ["succeeded", "failed", "stopped"];
const DEFAULTS: CleanupDeps = { sleep: (ms) => Bun.sleep(ms), polls: 20 };

/** Close only the exact handle, accepting only a receipt naming it with ptyKilled. Never throws. */
export async function closeCreatedTerminal(c: OrcaClient, terminal: string): Promise<{failure: string | null; proof: boolean}> {
  let failure = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const closed = await c.terminalClose(terminal);
      if (closed.ok) {
        const receipt = closed.result.close as {handle?: string; ptyKilled?: boolean} | undefined;
        if (receipt?.handle === terminal && receipt.ptyKilled === true) return {failure: null, proof: true};
        failure = "close receipt lacks exact handle and ptyKilled proof";
        continue;
      }
      failure = `${closed.error.code}: ${closed.error.message}`;
    } catch (e) { failure = String(e instanceof Error ? e.message : e); }
  }
  return {failure, proof: false};
}

export type WorkerLookup = { kind: "found"; dispatchId: string; state: string } | { kind: "none" } | { kind: "unknown"; reason: string };

/** Whether a dispatch is attached to this terminal in the run. "none" needs a complete, matching listing across every page. */
export async function lookupWorker(c: OrcaClient, run: string, terminal: string, maxPages = 50): Promise<WorkerLookup> {
  try {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await c.workerList(run, cursor);
      if (!r.ok) return { kind: "unknown", reason: `orca worker-list failed: ${r.error.code} ${r.error.message}` };
      const workers = r.result.workers;
      if (!Array.isArray(workers)) return { kind: "unknown", reason: "orca worker-list returned no workers" };
      if (r.result.scope?.run !== undefined && r.result.scope.run !== run) return { kind: "unknown", reason: "orca worker-list is incomplete for the run" };
      const w = workers.find(w => w.agentTerminalHandle === terminal || w.resource?.terminalHandle === terminal);
      if (w) return w.dispatchId ? { kind: "found", dispatchId: w.dispatchId, state: w.workerState ?? "" }
        : { kind: "unknown", reason: "orca worker-list row has no dispatch id" };
      if (r.result.page?.hasMore === false) return { kind: "none" };
      const next = r.result.page?.nextCursor;
      if (r.result.page?.hasMore !== true || typeof next !== "string" || !next || next === cursor) {
        return { kind: "unknown", reason: "orca worker-list is incomplete for the run" };
      }
      cursor = next;
    }
    return { kind: "unknown", reason: `orca worker-list has more than ${maxPages} pages` };
  } catch (e) {
    return { kind: "unknown", reason: String(e instanceof Error ? e.message : e) };
  }
}

/** Terminals Orca lists in exactly this worktree, except the given handles. Null when the listing failed or was truncated. */
export async function worktreeTerminals(c: OrcaClient, worktreeId: string, except: string[] = []): Promise<TerminalRow[] | null> {
  try {
    const r = await c.terminalList(`id:${worktreeId}`);
    if (!r.ok || !Array.isArray(r.result.terminals) || r.result.truncated === true) return null;
    return r.result.terminals.filter(t => typeof t?.handle === "string" && t.worktreeId === worktreeId && !except.includes(t.handle));
  } catch { return null; }
}

/** Record a pacer-owned terminal whose close had no receipt proof, so `pacer clean` retries it. */
export async function recordUnclosed(ctx: Ctx, taskId: string, terminal: string, log: (l: string) => void, worktreeId?: string): Promise<void> {
  try {
    await withLock(ctx, "coordinator", async () => {
      updateOrcaState(ctx, s => { s.unclosed[terminal] = { taskId, terminal, ...(worktreeId ? { worktreeId } : {}), at: ctx.now }; });
    });
    log(`recorded terminal ${terminal} for a later close by pacer clean`);
  } catch (e) { log(`recording unclosed terminal ${terminal} failed: ${String(e)}`); }
}

/**
 * Record a pacer-created worktree whose terminals could not be listed, with the initial terminals Orca named before
 * pacer's agent terminal existed. Orca's listing has no creation time, so `pacer clean` closes only these handles.
 */
export async function recordStrayRisk(ctx: Ctx, taskId: string, w: OwnedWorktree, initial: string[], log: (l: string) => void): Promise<void> {
  if (!initial.length) { log(`pacer cannot tell Orca's initial terminal in ${w.id} from others; it closes only terminals it recorded`); return; }
  try {
    await withLock(ctx, "coordinator", async () => {
      updateOrcaState(ctx, s => { s.strays[w.id] = { taskId, ...w, initial: [...new Set([...(s.strays[w.id]?.initial ?? []), ...initial])], at: ctx.now }; });
    });
    log(`recorded worktree ${w.id} for a stray terminal sweep by pacer clean`);
  } catch (e) { log(`recording worktree ${w.id} for a stray sweep failed: ${String(e)}`); }
}

/** Orca's reply proves the selector names this pacer-named, non-main worktree at this path. */
async function verifyOwned(c: OrcaClient, selector: string, want: { name: string; path: string; id?: string }): Promise<{ id: string } | { error: string; missing?: boolean }> {
  const shown = await c.worktreeShowBy(selector);
  if (!shown.ok) return { error: "Orca worktree ownership could not be verified", missing: shown.error.code === "selector_not_found" };
  const w = shown.result.worktree;
  if (!w?.id || (want.id && w.id !== want.id) || w.displayName !== want.name || w.isMainWorktree === true
    || realpathSafe(w.path ?? "") !== realpathSafe(want.path)) return { error: "Orca worktree ownership could not be verified" };
  return { id: w.id };
}

/** Orca removes worktrees asynchronously: report success only once the directory is gone. */
async function removeOwned(ctx: Ctx, c: OrcaClient, id: string, path: string, force: boolean, deps: CleanupDeps): Promise<string | null> {
  const r = await c.worktreeRemove(id, force);
  if (!r.ok) return r.error.message.trim() || "Orca worktree removal failed";
  // Removal kills the worktree's terminals without an operator-close receipt; remember that pacer did it.
  try {
    await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { s.removed[id] = { id, path, at: ctx.now }; }); });
  } catch { /* Without the record, a terminal pacer could not close keeps its lease. */ }
  for (let i = 0; existsSync(path); i++) {
    if (i >= deps.polls) return "Orca is still removing the worktree; run pacer clean again";
    await deps.sleep(500);
  }
  return null;
}

async function strand(ctx: Ctx, taskId: string, w: OwnedWorktree): Promise<void> {
  await withLock(ctx, "coordinator", async () => {
    updateOrcaState(ctx, s => { s.stranded[taskId] = { taskId, ...w, at: ctx.now }; });
  });
}

/** Remove a worktree pacer just created; when that fails, record it so `pacer clean` removes it. */
export async function discardCreatedWorktree(ctx: Ctx, c: OrcaClient, taskId: string, w: OwnedWorktree, log: (l: string) => void, over: Partial<CleanupDeps> = {}): Promise<void> {
  const deps = { ...DEFAULTS, ...over };
  let failure: string | null;
  try {
    const owned = await verifyOwned(c, `id:${w.id}`, w);
    failure = "error" in owned ? (owned.missing ? null : owned.error) : await removeOwned(ctx, c, w.id, w.path, true, deps);
  } catch (e) { failure = String(e instanceof Error ? e.message : e); }
  if (!failure) { log(`removed Orca worktree ${w.id}`); return; }
  try { await strand(ctx, taskId, w); } catch (e) { log(`recording Orca worktree ${w.id} failed: ${String(e)}`); }
  log(`Orca worktree ${w.id} not removed (${failure}); pacer clean removes it`);
}

async function removeStranded(ctx: Ctx, c: OrcaClient, s: StrandedWorktree, force: boolean, deps: CleanupDeps): Promise<string | null> {
  const owned = await verifyOwned(c, `id:${s.id}`, s);
  const failure = "error" in owned ? (owned.missing ? null : owned.error) : await removeOwned(ctx, c, s.id, s.path, force, deps);
  if (failure) return failure;
  await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, x => { delete x.stranded[s.taskId]; }); });
  return null;
}

/** Orca-created worktrees of a settled, reviewed task: its result worktree and any stranded pre-start worktree. */
export async function cleanOrcaTask(ctx: Ctx, t: TaskRecord, o: HostCleanOpts, over: Partial<CleanupDeps> = {}): Promise<HostClean> {
  const deps = { ...DEFAULTS, ...over };
  const c = new OrcaClient(ctx.run, ctx.env);
  const stranded = loadOrcaState(ctx).stranded[t.id];
  if (stranded && !o.dryRun) {
    const failure = await removeStranded(ctx, c, stranded, !!o.force, deps);
    if (failure) return { kept: failure };
  }
  if (t.result?.backend !== "orca" || t.placement?.mode !== "new" || !t.worktree) return null;
  if (!existsSync(t.worktree)) return { gone: true };
  const top = await ctx.run(["git", "-C", t.worktree, "rev-parse", "--show-toplevel"], 10_000);
  const path = top.code === 0 ? top.stdout.trim() : "";
  if (!path || realpathSafe(path) === realpathSafe(t.brief.repo)) return { kept: "Orca worktree path could not be resolved" };
  if (o.shared(t.worktree)) return { kept: "worktree is shared with an active or unreviewed task" };
  if (!o.force && await worktreeDirty(ctx, path) !== false) return { kept: "uncommitted changes; use --force" };
  const owned = await verifyOwned(c, `path:${path}`, { name: `pacer-${t.id}-${t.result.executor}`, path });
  if ("error" in owned) return { kept: owned.error };
  if (o.dryRun) return { removed: true };
  const failure = await removeOwned(ctx, c, owned.id, path, !!o.force, deps);
  return failure ? { kept: failure } : { removed: true };
}

/** A worker found settled after an uncertain start: show its worktree and outcome on the task, which needs review again. */
function attachSettled(ctx: Ctx, u: UncertainStart, dispatchId: string, state: string): void {
  updateTask(ctx, u.taskId, t => {
    const note = `Orca worker ${dispatchId} was found ${state} after the uncertain start${u.worktree ? `; its work is in ${u.worktree.path}` : ""}.`;
    if (u.worktree) { t.worktree ??= u.worktree.path; if (t.result) t.result.worktree ??= u.worktree.path; }
    if (t.result && !t.result.report.includes(note)) t.result.report = `${t.result.report}\n\n${note}`.trim();
    // Any review covered the "unstarted" result, not this work: `pacer clean` must not remove it unseen.
    delete t.review; delete t.dismissed; delete t.resolved;
  });
}

/** Orca's row when it shows the terminal disconnected and unwritable, or null. */
async function disconnected(c: OrcaClient, terminal: string): Promise<TerminalRow | null> {
  const shown = await c.terminalShow(terminal).catch(() => null);
  const row = shown?.ok ? shown.result.terminal : undefined;
  return row?.handle === terminal && row.connected === false && row.writable === false ? row : null;
}

/** A dead terminal in a worktree pacer itself removed is positive evidence its work ended: release its lease. */
function releaseRemoved(ctx: Ctx, row: TerminalRow, worktreeId: string | undefined, removed: Set<string>): void {
  if (!worktreeId || !removed.has(worktreeId) || (row.worktreeId !== undefined && row.worktreeId !== worktreeId)) return;
  try { releaseOrcaTerminalWorkSync(ctx, row.handle, row.incarnationId); } catch { /* A later pass retries. */ }
}

/** Close the recorded initial terminals Orca left in a pacer-created worktree; any other terminal may be the user's. */
async function sweepStrays(ctx: Ctx, c: OrcaClient, w: StrayRisk): Promise<boolean> {
  if (!w.initial.length) return true;
  const owned = await verifyOwned(c, `id:${w.id}`, w);
  if ("error" in owned) return !!owned.missing;
  const real = realpathSafe(w.path);
  // A task still running there may own a terminal pacer has not recorded yet.
  if (listTasksWhere(ctx, { states: ["queued", "running"] }).some(t => {
    const p = realpathSafe(t.worktree ?? t.result?.worktree ?? t.brief.repo);
    return p === real || p.startsWith(real + "/");
  })) return false;
  const s = loadOrcaState(ctx);
  const agents = [...Object.values(s.workers).map(x => x.terminal), ...Object.keys(s.uncertain), ...Object.keys(s.unclosed)].filter((x): x is string => !!x);
  const listed = await worktreeTerminals(c, w.id, agents);
  if (!listed) return false;
  let all = true;
  for (const t of listed.filter(t => w.initial.includes(t.handle))) all = (await closeCreatedTerminal(c, t.handle)).proof && all;
  return all;
}

/** Later pass: close terminals whose close had no proof, and uncertain-start terminals once no live worker can use them. */
export async function reconcileOrcaWork(ctx: Ctx): Promise<void> {
  const c = new OrcaClient(ctx.run, ctx.env);
  const removed = new Set(Object.keys(loadOrcaState(ctx).removed));
  // A terminal Orca already shows disconnected (for example, killed with its worktree) has nothing left to close.
  const closedOrGone = async (terminal: string, worktreeId: string | undefined): Promise<boolean> => {
    if ((await closeCreatedTerminal(c, terminal)).proof) return true;
    const row = await disconnected(c, terminal);
    if (row) releaseRemoved(ctx, row, worktreeId, removed);
    return !!row;
  };
  for (const u of Object.values(loadOrcaState(ctx).unclosed)) {
    if (await closedOrGone(u.terminal, u.worktreeId)) await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.unclosed[u.terminal]; }); });
  }
  for (const u of Object.values(loadOrcaState(ctx).uncertain)) {
    const found = await lookupWorker(c, u.run, u.terminal);
    if (found.kind === "unknown" || (found.kind === "found" && !SETTLED.includes(found.state))) continue;
    if (!(await closedOrGone(u.terminal, u.worktree?.id))) continue;
    if (found.kind === "found") attachSettled(ctx, u, found.dispatchId, found.state);
    await withLock(ctx, "coordinator", async () => {
      updateOrcaState(ctx, s => {
        delete s.uncertain[u.terminal];
        // No worker ran, so the worktree holds no work: remove it after review.
        if (found.kind === "none" && u.worktree) s.stranded[u.taskId] = { taskId: u.taskId, ...u.worktree, at: ctx.now };
      });
    });
  }
  for (const w of Object.values(loadOrcaState(ctx).strays)) {
    if (await sweepStrays(ctx, c, w)) await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.strays[w.id]; }); });
  }
  // Keep removal evidence only while a recorded terminal may still need it.
  await withLock(ctx, "coordinator", async () => {
    updateOrcaState(ctx, s => {
      const used = new Set([...Object.values(s.unclosed).map(u => u.worktreeId), ...Object.values(s.uncertain).map(u => u.worktree?.id)]);
      for (const id of Object.keys(s.removed)) if (!used.has(id)) delete s.removed[id];
    });
  });
}
