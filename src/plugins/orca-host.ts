import { resolveWorktreeBase, worktreeUnchanged } from "../supervisor/worktree";
import { pidAlive } from "../link/store";
import { basename } from "node:path";
import type { ExecutionCfg } from "../config/execution";
import type { ProviderCfg } from "../config/strategy";
import { readTask, listTasksWhere, updateTask } from "../tasks/store";
import { type LiveWorker, resolvePlacement, type ResolvedPlacement, type TaskRecord } from "../tasks/types";
import { taskActivity } from "../core/tasks";
import type { Ctx } from "../types";
import { buildPrompt } from "../exec/prompt";
import { orcaAgentFor } from "../exec/orca/agents";
import { laneWorktreeName, orcaWorktreeName } from "../exec/orca/names";
import { OrcaClient, type Placement, type WorktreeRow, isReady } from "../exec/orca/client";
import { closeCreatedTerminal, discardCreatedWorktree, type OwnedWorktree, recordUnclosed, releaseEmptyGroup } from "../exec/orca/cleanup";
import { ensureCoordinator, ensureGroupWorktree, ensureRepo, gitInfo, realpathSafe } from "../exec/orca/setup";
import { loadOrcaState, updateOrcaState, withLock } from "../exec/orca/state";
import { SETTLED_STATES, type WaitResult } from "../exec/orca/wait";

/** Host-side Orca effects of the #461 terminal-worker flow; the bundled pacer-exec-orca plugin sequences them. */
export interface Ready {
  ok: true;
  agent: string;
  model: string | null;
  coordinator: string;
  run: string;
  placement: Placement;
  top: string;
  main: string;
  base: string;
  sub: string;
  notes: string[];
  resolved: ResolvedPlacement;
}
export type Prepared = { ok: false; reason: string; refuse?:boolean } | Ready;

export async function prepareOrca(ctx: Ctx, c: OrcaClient, cfg: ProviderCfg, task: TaskRecord, ex: ExecutionCfg): Promise<Prepared> {
  const preliminary=resolvePlacement(task,ex.worktree,false);
  const pick = orcaAgentFor(cfg, task.retryOf && task.worktree ? "current" : preliminary.mode==="current"?"current":ex.worktree==="current"?"new-child":ex.worktree);
  if ("skip" in pick) return { ok: false, reason: pick.skip };
  if (!isReady(await c.status())) return { ok: false, reason: "the Orca runtime is not ready (orca status)" };
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return { ok: false, reason: git.error };
  const active=listTasksWhere(ctx, { states: ["running"] }).some(t=>{
    if(t.id===task.id||t.state!=="running"||!t.runnerPid||!pidAlive(t.runnerPid))return false;
    const path=realpathSafe(t.worktree??t.result?.worktree??t.brief.repo), top=realpathSafe(git.top);
    return path===top||path.startsWith(top+"/");
  });
  if(active&&task.placement?.requested==="current")return {ok:false,reason:"another pacer task is running in the current worktree; requested current placement refused",refuse:true};
  const resolved=resolvePlacement(task,ex.worktree,active,git.dirty);
  if(resolved.mode==="current"&&resolved.why==="strategy default"&&git.dirty)return {ok:false,reason:"current worktree has uncommitted changes",refuse:true};
  const mapped=orcaAgentFor(cfg,task.retryOf && task.worktree ? "current" : resolved.mode==="current"?"current":"new-child");
  if("skip" in mapped)return {ok:false,reason:mapped.skip};
  const resolvedBase = resolved.mode === "current" || (task.retryOf && task.worktree)
    ? { base: task.baseBranch ?? git.branch, sha: task.baseSha }
    : await resolveWorktreeBase(ctx, git.top, task.brief, ex.baseBranch, ex.worktree === "child-of-current" && task.placement?.requested !== "new");
  if ("error" in resolvedBase) return { ok: false, reason: resolvedBase.error, refuse: true };
  const base = resolvedBase.base;
  if (resolvedBase.sha) updateTask(ctx, task.id, t => { t.baseSha = resolvedBase.sha; });
  const repoId = await ensureRepo(c, git.top, {main:git.main,linked:git.linked,registerRepos:ex.registerRepos});
  if (typeof repoId !== "string") return { ok: false, reason: repoId.error };
  const coord = await ensureCoordinator(ctx, c, git.top);
  if ("error" in coord) return { ok: false, reason: coord.error };
  const notes: string[] = [];
  if (resolved.mode !== "current" && git.dirty) {
    notes.push(`note: ${git.top} has uncommitted changes; the worker's new worktree starts from ${base} without them`);
  }
  // New-child worktree names (laneWorktreeName) also identify executor hook sessions.
  // A --group lane is still a new-child worktree, nested under the group's shared parent worktree.
  let parentWorktree: string | undefined;
  if (!(task.retryOf && task.worktree) && resolved.mode !== "current" && task.group) {
    const group = await ensureGroupWorktree(ctx, c, repoId, task.group, resolvedBase.sha ?? base);
    if ("error" in group) return { ok: false, reason: group.error };
    parentWorktree = group.selector;
  }
  const placement: Placement = task.retryOf && task.worktree
    ? { kind: "existing", selector: `path:${task.worktree}` }
    : resolved.mode !== "current"
    ? { kind: "new-child", repoId, baseBranch: resolvedBase.sha ?? base, name: laneWorktreeName(task.id, cfg.id), ...(parentWorktree ? { parentWorktree } : {}) }
    : { kind: "existing", selector: `path:${git.top}` };
  return {
    ok: true, agent: mapped.agent, model: mapped.model, coordinator: coord.coordinator, run: coord.run,
    placement, top: git.top, main: git.main, base, sub: git.sub, notes, resolved,
  };
}

export function workerSpec(task: TaskRecord, p: Ready): string {
  const where = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
    : `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}` +
      `${p.placement.parentWorktree && task.group ? `, grouped under ${task.group}` : ""}` +
      `${p.sub ? `. Work in its ${p.sub}/ subdirectory` : ""}. Do not edit ${p.top} itself.`;
  const prompt = buildPrompt({ ...task.brief, repo: where }, task.id);
  return prompt;
}
/** Release or stop the dispatch; the caller closes the terminal. */
export async function settleWorker(c: OrcaClient, dispatchId: string, settled: boolean, log: (l: string) => void, receipt: (reply: Awaited<ReturnType<OrcaClient["workerStop"]>>) => void): Promise<void> {
  let stop = !settled;
  if (settled) {
    const rel = await c.workerRelease(dispatchId);
    receipt(rel);
    log(`worker-release: ${rel.ok ? (rel.result.state ?? "ok") : rel.error.code}`);
    if (!rel.ok && rel.error.code === "dispatch_inactive") stop = true;
  }
  if (stop) {
    const st = await c.workerStop(dispatchId);
    receipt(st);
    log(`worker-stop: ${st.ok ? (st.result.state ?? "ok") : st.error.code}`);
  }
}
export function waitLine(dispatchId: string, w: WaitResult): string {
  switch (w.kind) {
    case "done": return `worker_done ${dispatchId}: ${w.outcome}`;
    case "settled": return `worker ${dispatchId} settled: ${w.state}${w.error ? ` (${w.error})` : ""}`;
    case "timeout": return `worker ${dispatchId}: timed out`;
    case "stopped": return `worker ${dispatchId}: stopped by the planner`;
  }
}

/** The worktree Orca returned must be the one pacer asked for (new-child name under the repo, or the existing path). */
export function checkedWorktree(p: Ready, w: WorktreeRow | undefined): { id: string; path: string } {
  const id = w?.id;
  if (!id) throw Error("orca worktree returned no id");
  const sep = id.indexOf("::"), path = sep > 0 ? id.slice(sep + 2) : "";
  const mismatch = (why: string) => Error(`orca worktree ${id} does not match the requested worktree: ${why}`);
  if (!path.startsWith("/")) throw mismatch("no absolute path in its id");
  if (w.path && realpathSafe(w.path) !== realpathSafe(path)) throw mismatch(`path ${w.path}`);
  if (p.placement.kind === "new-child") {
    if (id.slice(0, sep) !== p.placement.repoId) throw mismatch(`repo is not ${p.placement.repoId}`);
    if (basename(path) !== p.placement.name) throw mismatch(`name is not ${p.placement.name}`);
    if (realpathSafe(path) === realpathSafe(p.top)) throw mismatch("it is the repository itself");
  } else {
    // A retry may resolve its original worktree from a repository subdirectory inside it.
    const want = realpathSafe(p.placement.selector.slice("path:".length)), real = realpathSafe(path);
    if (want !== real && !want.startsWith(real + "/")) throw mismatch(`path does not contain ${want}`);
  }
  return { id, path };
}

export interface LiveAnswerWorker { asked: TaskRecord; live: LiveWorker; worktree: string | null }

/**
 * Why the lane's agent cannot take input right now, or null when it can: the worker must be unsettled and the terminal
 * must still report the agent pacer launched. Orca types `--text` into whatever runs in the terminal. The agent is
 * launched with `exec`, so no shell sits behind it; this check is the second guard, and it fails closed.
 */
export async function liveAgentProblem(c: OrcaClient, live: LiveWorker): Promise<string | null> {
  const show = await c.workerShow(live.worker);
  if (!show.ok) return `worker-show failed: ${show.error.code}`;
  const state = show.result.worker?.state;
  if (!state || SETTLED_STATES.includes(state)) return `the worker is ${state ?? "gone"}`;
  const shown = await c.terminalShow(live.terminal);
  if (!shown.ok) return `terminal show failed: ${shown.error.code}`;
  const row = shown.result.terminal;
  if (!row || row.handle !== live.terminal) return "the terminal is gone";
  if (live.incarnation && row.incarnationId && row.incarnationId !== live.incarnation) return "the terminal was restarted";
  if (row.connected === false || row.writable === false) return "the terminal is not writable";
  if (row.agentIdentity !== live.agent) return row.agentIdentity ? `${row.agentIdentity}, not ${live.agent}, is in the foreground` : `${live.agent} is not in the foreground (a shell may be)`;
  return null;
}
/**
 * A stopped interactive lane, or a settled one when `settled` is set, gives back what it created in Orca: its new-child
 * worktree, when it holds no work (no uncommitted changes, no commits beyond its base), and then its `--group` parent
 * once no lane is left under it. A worktree with work stays for review and `pacer clean`. ADR 0014 §3 lists the callers.
 * Returns whether the worktree was removed. Never throws.
 */
export async function releaseStoppedLane(
  ctx: Ctx, c: OrcaClient, task: TaskRecord, w: OwnedWorktree | null, log: (line: string) => void, sleep?: (ms: number) => Promise<void>, settled = false,
): Promise<boolean> {
  try {
    const current = readTask(ctx, task.id);
    if (!w || !current || (current.state !== "stopped" && !settled) || current.interactionMode !== "conversation") return false;
    const unchanged = await worktreeUnchanged(ctx, w.path, current.baseSha ?? current.baseBranch);
    if (unchanged !== true) {
      log(`kept the lane's Orca worktree ${w.id}: ${unchanged === false ? "it holds work" : "git could not tell whether it holds work"}; pacer clean removes it after review`);
      return false;
    }
    await discardCreatedWorktree(ctx, c, task.id, w, log, sleep ? { sleep } : {});
    if (loadOrcaState(ctx).stranded[task.id]?.id === w.id) return false;
    const sep = w.id.indexOf("::");
    if (current.group && sep > 0) await releaseEmptyGroup(ctx, c, w.id.slice(0, sep), current.group, log, sleep ? { sleep } : {});
    // Forget the removed path, so an answer or retry starts fresh instead of reaching for a missing worktree.
    const gone = (p?: string) => p === w.path || !!p?.startsWith(`${w.path}/`);
    updateTask(ctx, task.id, t => {
      if (gone(t.worktree)) delete t.worktree;
      if (t.result && gone(t.result.worktree)) delete t.result.worktree;
      t.worktreeReleased = { at: ctx.now, path: w.path };
    });
    taskActivity(ctx, current, "message", `Removed the lane's unused Orca worktree ${w.path}`);
    return true;
  } catch (e) {
    log(`releasing the lane's worktree failed: ${String(e instanceof Error ? e.message : e)}`);
    return false;
  }
}

/** The pacer-created lane worktree a live worker runs in, identified through Orca by its path and lane name. */
export async function liveLaneWorktree(ctx: Ctx, c: OrcaClient, task: TaskRecord, live: LiveWorker): Promise<OwnedWorktree | null> {
  const recorded = loadOrcaState(ctx).workers[live.worker]?.worktree ?? readTask(ctx, task.id)?.worktree ?? task.worktree;
  if (!recorded || realpathSafe(recorded) === realpathSafe(task.brief.repo)) return null;
  const top = await ctx.run(["git", "-C", recorded, "rev-parse", "--show-toplevel"], 10_000);
  const path = top.code === 0 ? top.stdout.trim() : "";
  // An answer moves the worker to a new task, but the worktree keeps the name of the lane that created it.
  const name = basename(path);
  if (!path || !LANE_NAME.test(name) || !name.endsWith(`-${orcaWorktreeName(live.executor)}`)) return null;
  const shown = await c.worktreeShow(path);
  const id = shown.ok ? shown.result.worktree?.id : undefined;
  return id ? { id, path, name } : null;
}
const LANE_NAME = /^pacer-t-\d{8}-\d{6}-[0-9a-f]{4}-/;

/** Stop a live worker, close its terminal and forget it, as a settled attempt would. */
export async function releaseLive(ctx: Ctx, c: OrcaClient, task: TaskRecord, why: string, log: (line: string) => void = () => {}): Promise<void> {
  const live = task.live;
  if (!live || live.backend !== "orca") return;
  log(`releasing live orca worker ${live.worker} of ${task.id}: ${why}`);
  const stopped = await c.workerStop(live.worker);
  log(`worker-stop: ${stopped.ok ? (stopped.result.state ?? "ok") : stopped.error.code}`);
  const closed = await closeCreatedTerminal(c, live.terminal);
  log(`closed pacer terminal ${live.terminal}: ${closed.failure ?? "ok"}`);
  if (!closed.proof) await recordUnclosed(ctx, task.id, live.terminal, log);
  const current = readTask(ctx, task.id);
  // A task still waiting for an answer keeps its worktree, so the answer can start from it.
  const releaseLane = current?.state === "stopped" || current?.state === "done" || current?.state === "partial" || current?.state === "failed" || current?.state === "limit";
  const lane = releaseLane ? await liveLaneWorktree(ctx, c, task, live).catch(() => null) : null;
  await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[live.worker]; }); });
  updateTask(ctx, task.id, t => { if (t.live?.worker === live.worker) delete t.live; });
  taskActivity(ctx, task, "message", `Stopped the live ${live.agent} worker: ${why}`);
  await releaseStoppedLane(ctx, c, task, lane, log, undefined, releaseLane);
}

/**
 * An interactive lane's escalation (`pacer ask`) leaves its worker and terminal alive and recorded on the task
 * (`TaskRecord.live`). Answering it reattaches to that process instead of spawning a fresh worker, on every round: the
 * worker moves to each answering attempt in turn. A worker whose agent is gone, a retry that is not an answer, or an
 * answer routed to another executor releases the old worker first, so two agents never share one worktree.
 */
export async function findLiveAnswerWorker(ctx: Ctx, c: OrcaClient, task: TaskRecord, executor: string): Promise<LiveAnswerWorker | null> {
  // A plain `pacer delegate --interactive` answer creates a new, retryOf-linked task; a managed
  // (dispatch.child) answer restarts the same task id in place (src/core/work.ts `restartWork`).
  const asked = task.retryOf ? readTask(ctx, task.retryOf) : task;
  if (!asked?.live || asked.live.backend !== "orca") return null;
  const answering = task.retryOf ? asked.question?.answer !== undefined : task.brief.qa?.length;
  const problem = asked.interactionMode !== "conversation" ? "not an interactive lane"
    : !answering ? "a retry is not an answer" : asked.live.executor !== executor ? `the answer runs on ${executor}`
    : await liveAgentProblem(c, asked.live);
  if (problem) {
    await releaseLive(ctx, c, asked, problem).catch(() => { /* the supervision pass retries the release */ });
    return null;
  }
  const worker = loadOrcaState(ctx).workers[asked.live.worker];
  return { asked, live: asked.live, worktree: worker?.worktree ?? asked.worktree ?? null };
}

export interface Mapped { code: number; timedOut: boolean; settled: boolean; summary: string; tail?: string; launchBroken?: string }

/** The attempt outcome a supervised wait means (#461); only a reported or settled worker is released rather than stopped. */
export function mapWait(w: WaitResult): Mapped {
  switch (w.kind) {
    case "done":
      return {
        code: w.outcome === "succeeded" ? 0 : 1, timedOut: false, settled: true,
        summary: [w.subject, w.body].filter((x) => x.trim()).join("\n\n") || `worker_done: ${w.outcome}`,
      };
    case "settled":
      return {
        code: w.state === "succeeded" ? 0 : 1, timedOut: false, settled: !w.needsStop, ...(w.tail === undefined ? {} : { tail: w.tail }),
        summary: `orca worker ${w.state} without a worker_done report${w.error ? ` (${w.error})` : ""}`,
      };
    case "timeout":
      return { code: 1, timedOut: true, settled: false, summary: "orca worker timed out at the task timeout; stopped it" };
    case "stopped":
      return { code: 1, timedOut: false, settled: false, summary: "stopped by the planner; stopped the orca worker" };
  }
}

/** A worker that did not start ready; an agent-launch failure marks the attempt broken. */
export function mapFailedStart(start: { stage?: string; failedStage?: string; lastError?: string | null }): Mapped {
  const launchBroken = /agent[ _-]?launch|launch[ _-]?agent/i.test(start.failedStage ?? "")
    ? `orca agent launch failed: ${start.lastError ?? "no error given"}` : undefined;
  return { code: 1, timedOut: false, settled: true,
    summary: `orca worker failed to start at ${start.failedStage ?? start.stage ?? "an unknown stage"}: ${start.lastError ?? "no error given"}`,
    ...(launchBroken ? { launchBroken } : {}) };
}
