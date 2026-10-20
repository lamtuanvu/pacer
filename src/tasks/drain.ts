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
import { slotBlock, slotUse } from "../engine/slots";
import { computeStatus, type Status } from "../engine/status";
import { remoteExclusion } from "../remote/eligibility";
import { gitInfo } from "../core/git";
import type { Ctx } from "../types";
import { spawnRunner, type SpawnRunner } from "./api";
import { listTasksWhere, readTask, updateTask } from "./store";
import { resolvePlacement } from "./types";

interface DrainDeps {
  hooks?: DecisionHooks;
  loadStrategy(ctx: Ctx): Strategy;
  computeStatus(ctx: Ctx, s: Strategy): Promise<Status>;
}
const defaults: DrainDeps = {loadStrategy, computeStatus};

/** Reserve slots before spawning so concurrent drains and runners see the same capacity. */
export async function drainQueue(ctx: Ctx, spawn: SpawnRunner = spawnRunner, deps: DrainDeps = defaults): Promise<string[]> {
  if (ctx.readOnly) return [];
  return withLock(ctx, "drain", async () => {
    const waiting = listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (!waiting.length) return [];
    const spawned: string[] = [], hooks = deps.hooks ?? activeHooks;
    let st: Status | undefined;
    let policyChanges = 0;
    for (let index = 0; index < waiting.length; index++) {
      const task = waiting[index], s = deps.loadStrategy(ctx);
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
      st ??= await deps.computeStatus(ctx, s);
      const blocked = readBlocked(ctx), broken = readBroken(ctx);
      const statuses = Object.fromEntries(st.providers.map(p => [p.id, {...p,
        ...(blocked[p.id] ? {blockedReason: blocked[p.id].reason} : {}),
        ...(broken[p.id] ? {brokenReason: broken[p.id].reason} : {}),
      }]));
      const kind = await Promise.resolve().then(() => hooks.taskKind(ctx, task)).catch(() => task.kind);
      const ranking = rankExecutors(kind, s, statuses, selection && { executors: selection.executors, order: "configured" });
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
      let policyChanged = false;
      await withLock(ctx, "slots", async () => {
        const reserved = await withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
        requirePolicyIdentity(ctx, repo);
        if (projectRevision(readProjectStrategies(ctx), snapshot.repoKey) !== snapshot.rev) { policyChanged = true; return; }
        const current = readTask(ctx, task.id);
        if (current?.state !== "queued" || !current.queue || readPause(ctx)) return;
        if (selection && !eligible.length) {
          updateTask(ctx, task.id, t => {
            t.state = "limit"; delete t.queue;
            const reasons = ranking.excluded.map(e => `${e.id}: ${e.reason}`).join(", ") || "no choices passed the routing filter";
            t.result = {status:"limit",executor:null,model:null,files:"",report:`no project executor available (${reasons})`,backend:"direct"};
          });
          return;
        }
        const use = slotUse(listTasksWhere(ctx, { states: ["running"] }));
        const executor = eligible.find(id => !slotBlock(s, id, use));
        if (!executor) return;
        // A running reservation is claimed by the spawned process before its first attempt.
        updateTask(ctx, task.id, t => {t.state = "running"; t.executor = executor; delete t.queue; delete t.runnerPid;});
        return current;
        });
        if (!reserved) return;
        try {
          const pid = spawn(ctx, task.id);
          updateTask(ctx, task.id, t => {t.runnerPid = pid;});
          spawned.push(task.id);
        } catch (error) {
          updateTask(ctx, task.id, t => {t.state = "queued"; t.queue = reserved.queue; delete t.executor; delete t.runnerPid;});
          throw error;
        }
      });
      if (policyChanged && ++policyChanges <= 20) { index--; st = undefined; }
    }
    // Positions are presentation metadata; preserve the age of each wait.
    listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .forEach((t, i) => updateTask(ctx, t.id, x => {if (x.queue) x.queue.position = i + 1;}));
    return spawned;
  });
}
