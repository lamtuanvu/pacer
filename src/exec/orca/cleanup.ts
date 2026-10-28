import { existsSync } from "node:fs";
import { worktreeDirty } from "../../supervisor/worktree";
import type { TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import type { HostClean, HostCleanOpts } from "../cleanup";
import { OrcaClient } from "./client";
import { realpathSafe } from "./setup";
import { loadOrcaState, type StrandedWorktree, updateOrcaState, withLock } from "./state";

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

/** Whether a dispatch is attached to this terminal in the run. "none" needs a complete, matching listing. */
export async function lookupWorker(c: OrcaClient, run: string, terminal: string): Promise<WorkerLookup> {
  try {
    const r = await c.workerList(run);
    if (!r.ok) return { kind: "unknown", reason: `orca worker-list failed: ${r.error.code} ${r.error.message}` };
    const workers = r.result.workers;
    if (!Array.isArray(workers)) return { kind: "unknown", reason: "orca worker-list returned no workers" };
    const w = workers.find(w => w.agentTerminalHandle === terminal || w.resource?.terminalHandle === terminal);
    if (w) return w.dispatchId ? { kind: "found", dispatchId: w.dispatchId, state: w.workerState ?? "" }
      : { kind: "unknown", reason: "orca worker-list row has no dispatch id" };
    if (r.result.page?.hasMore !== false || (r.result.scope?.run !== undefined && r.result.scope.run !== run)) {
      return { kind: "unknown", reason: "orca worker-list is incomplete for the run" };
    }
    return { kind: "none" };
  } catch (e) {
    return { kind: "unknown", reason: String(e instanceof Error ? e.message : e) };
  }
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
async function removeOwned(c: OrcaClient, id: string, path: string, force: boolean, deps: CleanupDeps): Promise<string | null> {
  const r = await c.worktreeRemove(id, force);
  if (!r.ok) return r.error.message.trim() || "Orca worktree removal failed";
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
    failure = "error" in owned ? (owned.missing ? null : owned.error) : await removeOwned(c, w.id, w.path, true, deps);
  } catch (e) { failure = String(e instanceof Error ? e.message : e); }
  if (!failure) { log(`removed Orca worktree ${w.id}`); return; }
  try { await strand(ctx, taskId, w); } catch (e) { log(`recording Orca worktree ${w.id} failed: ${String(e)}`); }
  log(`Orca worktree ${w.id} not removed (${failure}); pacer clean removes it`);
}

async function removeStranded(ctx: Ctx, c: OrcaClient, s: StrandedWorktree, force: boolean, deps: CleanupDeps): Promise<string | null> {
  const owned = await verifyOwned(c, `id:${s.id}`, s);
  const failure = "error" in owned ? (owned.missing ? null : owned.error) : await removeOwned(c, s.id, s.path, force, deps);
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
  const failure = await removeOwned(c, owned.id, path, !!o.force, deps);
  return failure ? { kept: failure } : { removed: true };
}

/** Later pass for uncertain worker starts: close the terminal once no live worker can use it. */
export async function reconcileOrcaWork(ctx: Ctx): Promise<void> {
  const c = new OrcaClient(ctx.run, ctx.env);
  for (const u of Object.values(loadOrcaState(ctx).uncertain)) {
    const found = await lookupWorker(c, u.run, u.terminal);
    if (found.kind === "unknown" || (found.kind === "found" && !SETTLED.includes(found.state))) continue;
    if (!(await closeCreatedTerminal(c, u.terminal)).proof) continue;
    await withLock(ctx, "coordinator", async () => {
      updateOrcaState(ctx, s => {
        delete s.uncertain[u.terminal];
        if (u.worktree) s.stranded[u.taskId] = { taskId: u.taskId, ...u.worktree, at: ctx.now };
      });
    });
  }
}
