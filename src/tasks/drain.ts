import { authorizeRoute } from "./policy-route";
import { policySummary } from "../plugins/policy";
import { CoreError } from "../core/errors";
import { getWork, pendingDependencies } from "../dispatch/work";
import { beginWorkSync, finishWorkSync, finishUnlaunchedWorkSync } from "../update/desktop/admission";
import { executorExclusion } from "../executors/availability";
import { PROJECT_STRATEGIES_LOCK, projectRevision, readProjectStrategies } from "../config/project-strategies";
import { projectSnapshot, requireProjectExecutor } from "../core/project-policy";
import { resolvePolicyRepo, requirePolicyIdentity } from "../core/project-policy";
import { loadStrategy, type Strategy } from "../config/strategy";
import { resolveRunner } from "../config/runner-id";
import { validateExecution } from "../config/execution";
import type { DecisionHooks } from "../classify/hooks";
import { activeHooks } from "../classify/active";
import { withLock } from "../core/lock";
import { readPause } from "../core/pause";
import { readBlocked } from "../executors/blocked";
import { readBroken } from "../exec/broken";
import { rankExecutors } from "../engine/rank";
import { SLOT_STATES, slotBlock, slotUse, type SlotUse } from "../engine/slots";
import { queueCapacity } from "./capacity";
import { computeStatus, type Status } from "../engine/status";
import { remoteExclusion } from "../remote/eligibility";
import { gitInfo } from "../core/git";
import type { Ctx } from "../types";
import { spawnRunner, launchTaskRunner, type SpawnRunner } from "./api";
import { listTasksWhere, readTask, updateTask } from "./store";
import { resolvePlacement } from "./types";

export interface DrainDeps {
  now?: () => number;
  hooks?: DecisionHooks;
  loadStrategy(ctx: Ctx): Strategy;
  computeStatus(ctx: Ctx, s: Strategy): Promise<Status>;
}
const defaults: DrainDeps = {loadStrategy, computeStatus};

const CAPACITY_REASONS: readonly string[] = ["no_slot", "machine_memory_pressure", "machine_load"];
/** Keep a capacity wait's reason current: machine pressure can change without any task finishing. */
const NO_EXECUTOR = "Waiting for an available executor";
/** A capacity wait, or the neutral wait this function wrote in place of a stale machine reason. */
const refreshable = (q: {reason: string; limit?: string; detail?: string}) => CAPACITY_REASONS.includes(q.reason) || (q.reason === "waiting_retry" && q.limit === "machine" && q.detail === NO_EXECUTOR);
function refreshCapacityWait(ctx: Ctx, id: string, s: Strategy, executor: string | undefined, use: SlotUse): void {
  const current = readTask(ctx, id)?.queue;
  if (!current || !refreshable(current)) return;
  const next = executor ? queueCapacity(s, executor, use) : undefined;
  if (!next) {
    // Nothing capacity-related holds it now (e.g. every executor is excluded): drop a stale machine reason.
    if (current.reason.startsWith("machine_")) updateTask(ctx, id, t => {
      if (t.state !== "queued" || !t.queue || !refreshable(t.queue)) return;
      t.queue = {reason: "waiting_retry", limit: "machine", detail: NO_EXECUTOR, since: t.queue.since, position: t.queue.position};
    });
    return;
  }
  const same = current.reason === next.reason && current.limit === next.limit && current.detail === next.detail
    && JSON.stringify(current.capacity) === JSON.stringify(next.capacity) && JSON.stringify(current.machine) === JSON.stringify(next.machine);
  if (same) return;
  updateTask(ctx, id, t => {
    if (t.state !== "queued" || !t.queue || !refreshable(t.queue)) return;
    const {since, position} = t.queue;
    t.queue = {reason: next.reason, since, position, limit: next.limit,
      ...(next.capacity ? {capacity: next.capacity} : {}), ...(next.detail ? {detail: next.detail} : {}), ...(next.machine ? {machine: next.machine} : {})};
  });
}

/** Hold a queued task whose route policy refused or failed; a conflict only retries on the next drain. */
function holdForPolicy(ctx: Ctx, id: string, error: unknown): void {
  if (error instanceof CoreError && error.code === "conflict") return;
  const detail = error instanceof CoreError ? `${error.message}${error.hint ? ` (${error.hint})` : ""}` : String(error);
  const now = Date.now() / 1000;
  updateTask(ctx, id, t => {
    if (t.state !== "queued" || !t.queue) return;
    t.queue = {...t.queue, reason: "waiting_retry", detail: `Route policy: ${detail}`.slice(0, 500), nextAt: now + 30};
  });
}

/** Reserve slots before spawning so concurrent drains and runners see the same capacity. */
export async function drainQueue(ctx: Ctx, spawn: SpawnRunner = spawnRunner, deps: DrainDeps = defaults): Promise<string[]> {
  if (ctx.readOnly) return [];
  let operation: string;
  try { operation = beginWorkSync(ctx, { kind: "operation", id: "queue-drain", label: "Queue drain" }); }
  catch { return []; } // Queued work retains its existing retry intent.
  const launches = new Map<string, string>();
  try {
    for (const task of listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue)) {
      launches.set(task.id, beginWorkSync(ctx, { kind: "task", id: task.id, label: `Queued task ${task.id}` }));
    }
    return await withLock(ctx, "drain", async () => {
    const waiting = listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue && launches.has(t.id))
      .sort((a, b) => (getWork(ctx,b.id)?.options.priority??0)-(getWork(ctx,a.id)?.options.priority??0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (!waiting.length) return [];
    const budgetNow=deps.now??Date.now;
    const policyDeadline=budgetNow()+10_000;
    const openPolicy=policySummary(ctx).mode==="open";
    const spawned: string[] = [], hooks = deps.hooks ?? activeHooks;
    let st: Status | undefined;
    let policyChanges = 0;
    for (let index = 0; index < waiting.length; index++) {
      if(openPolicy&&budgetNow()>=policyDeadline)break;
      const task = waiting[index], s = deps.loadStrategy(ctx);
      const work=getWork(ctx,task.id);
      if(work?.options.expiresAt!==undefined&&work.options.expiresAt<=Date.now()/1000){
        updateTask(ctx,task.id,t=>{t.state="failed";delete t.queue;t.result={status:"failed",executor:null,model:null,files:"",report:"Work dispatch deadline expired",backend:"direct"};});
        continue;
      }
      if(task.queue?.nextAt && task.queue.nextAt>Date.now()/1000)continue;
      if(work&&pendingDependencies(ctx,task.id).length)continue;
      let snapshot: ReturnType<typeof projectSnapshot>;
      let repo: import("../api/read-model/types").RepoRef;
      try {
        repo = task.repo && !task.repo.identityUnverified ? task.repo : await resolvePolicyRepo(ctx, task.brief.repo);
        snapshot = projectSnapshot(ctx, s, repo.key);
        requireProjectExecutor(snapshot.selection, task.requestedExecutor);
        if (task.repo?.key !== repo.key) updateTask(ctx, task.id, t => { t.repo = repo; });
      } catch (error) {
        updateTask(ctx, task.id, t => {
          if (t.state !== "queued" || !t.queue) return;
          t.state = "failed"; delete t.queue;
          t.result = { status: "failed", executor: null, model: null, files: "", report: String(error), backend: "direct" };
        });
        continue;
      }
      const selection = snapshot.selection;
      const req = task.requestedExecutor;
      if (req && !resolveRunner(s, req)) {
        updateTask(ctx, task.id, t => {
          if (t.state !== "queued" || !t.queue) return;
          t.state = "failed";
          delete t.queue;
          t.result = {status: "failed", executor: req, model: null, files: "", report: `${req} was removed while the task waited`, backend: "direct"};
        });
        continue;
      }
      if (readPause(ctx)) continue;
      st = await deps.computeStatus({ ...ctx, now: Date.now() / 1000 }, s);
      const blocked = readBlocked(ctx), broken = readBroken(ctx);
      const statuses = Object.fromEntries(st.providers.map(p => [p.id, {...p,
        ...(blocked[p.id] ? {blockedReason: blocked[p.id].reason} : {}),
        ...(broken[p.id] ? {brokenReason: broken[p.id].reason} : {}),
      }]));
      const kind = await Promise.resolve().then(() => hooks.taskKind(ctx, task)).catch(() => task.kind);
      const ranking = rankExecutors(kind, s, statuses, selection && { executors: selection.executors, order: "configured" }, {includePlanner:getWork(ctx,task.id)?.options.allowDelegation});
      let candidates = ranking.ranked.map(e => e.id);
      if (req) candidates = candidates.filter(id => id === req);
      else {
        const filtered = await Promise.resolve().then(() => hooks.filterExecutors(ctx, task, candidates, s)).catch(() => candidates);
        if (Array.isArray(filtered)) candidates = candidates.filter(id => filtered.includes(id));
      }
      const eligible: string[] = [];
      for (const id of candidates) {
        if (resolveRunner(s, id)?.host) {
          const git = await gitInfo(ctx.run, task.brief.repo).catch(() => null);
          const placement = task.placement?.mode ?? resolvePlacement(task, validateExecution(s.execution).worktree, false, !!git && !("error" in git) && git.dirty).mode;
          const reason = await remoteExclusion(ctx, s, id, {repo: task.brief.repo, placement}, {skipSlots: true});
          if (reason) { ranking.excluded.push({id, reason}); continue; }
        }
        eligible.push(id);
      }
      let routeAdmission: Awaited<ReturnType<typeof authorizeRoute>>;
      try {
        routeAdmission=await authorizeRoute({...ctx,now:Date.now()/1000},task.id,eligible,{
          strategy:current=>deps.loadStrategy(current),contextFingerprint:()=>JSON.stringify({repo:snapshot.repoKey,projectRevision:snapshot.rev}),budgetDeadline:policyDeadline,
        });
      } catch (error) {
        // Route admission concerns this task only: hold it with the reason and keep draining.
        holdForPolicy(ctx, task.id, error);
        continue;
      }
      if(openPolicy&&budgetNow()>=policyDeadline)break;
      for(const [id,plugin] of Object.entries(routeAdmission.excludedBy)) ranking.excluded.push({id,reason:`excluded by plugin ${plugin}`});
      const permitted=routeAdmission.candidates;
      let policyChanged = false;
      try { await withLock(ctx, "slots", async () => {
        const reserved = await withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
        routeAdmission.revalidate();
        requirePolicyIdentity(ctx, repo);
        if (projectRevision(readProjectStrategies(ctx), snapshot.repoKey) !== snapshot.rev) { policyChanged = true; return; }
        const current = readTask(ctx, task.id);
        if (current?.state !== "queued" || !current.queue || readPause(ctx)) return;
        if (selection && !permitted.length && task.interactionMode !== "conversation") {
          updateTask(ctx, task.id, t => {
            routeAdmission.revalidate();
            t.state = "limit"; delete t.queue;
            const reasons = ranking.excluded.map(e => `${e.id}: ${e.reason}`).join(", ") || "no choices passed the routing filter";
            t.result = {status:"limit",executor:null,model:null,files:"",report:`no project executor available (${reasons})`,backend:"direct"};
          });
          return;
        }
        const use = slotUse(listTasksWhere(ctx, { states: SLOT_STATES }));
        const executor = permitted.find(id => !executorExclusion(ctx, s, id) && !slotBlock(s, id, use, {guard: true}));
        if (!executor) { refreshCapacityWait(ctx, task.id, s, permitted.find(id => !executorExclusion(ctx, s, id)), use); return; }
        // A running reservation is claimed by the spawned process before its first attempt.
        const selected=updateTask(ctx, task.id, t => {routeAdmission.revalidate();t.state = "running"; t.executor = executor; delete t.queue; delete t.runnerPid;});
        routeAdmission.checkpoint(selected);
        return current;
        });
        if (!reserved) return;
        try {
          const pid = launchTaskRunner(ctx, task.id, spawn, launches.get(task.id));
          updateTask(ctx, task.id, t => {t.runnerPid = pid;});
          spawned.push(task.id);
        } catch (error) {
          updateTask(ctx, task.id, t => {t.state = "queued"; t.queue = reserved.queue; delete t.executor; delete t.runnerPid;});
          throw error;
        }
      }); } catch (error) {
        // A policy context change while reserving leaves the task queued for the next drain.
        if (error instanceof CoreError && error.code === "conflict") continue;
        throw error;
      }
      if (policyChanged && ++policyChanges <= 20) { index--; st = undefined; }
    }
    // Positions are presentation metadata; preserve the age of each wait.
    listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .forEach((t, i) => updateTask(ctx, t.id, x => {if (x.queue) x.queue.position = i + 1;}));
    return spawned;
  }); } finally {
    for (const lease of launches.values()) finishUnlaunchedWorkSync(ctx, lease);
    finishWorkSync(ctx, operation);
  }
}
