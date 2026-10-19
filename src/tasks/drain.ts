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
    const s = deps.loadStrategy(ctx), spawned: string[] = [], hooks = deps.hooks ?? activeHooks;
    let st: Status | undefined;
    for (const task of waiting) {
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
      let candidates = rankExecutors(kind, s, statuses).ranked.map(e => e.id);
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
          if (await remoteExclusion(ctx, s, id, {repo: task.brief.repo, placement}, {skipSlots: true})) continue;
        }
        eligible.push(id);
      }
      await withLock(ctx, "slots", async () => {
        const current = readTask(ctx, task.id);
        if (current?.state !== "queued" || !current.queue || readPause(ctx)) return;
        const use = slotUse(listTasksWhere(ctx, { states: ["running"] }));
        const executor = eligible.find(id => !slotBlock(s, id, use));
        if (!executor) return;
        // A running reservation is claimed by the spawned process before its first attempt.
        updateTask(ctx, task.id, t => {t.state = "running"; t.executor = executor; delete t.queue; delete t.runnerPid;});
        try {
          const pid = spawn(ctx, task.id);
          updateTask(ctx, task.id, t => {t.runnerPid = pid;});
          spawned.push(task.id);
        } catch (error) {
          updateTask(ctx, task.id, t => {t.state = "queued"; t.queue = current.queue; delete t.executor; delete t.runnerPid;});
          throw error;
        }
      });
    }
    // Positions are presentation metadata; preserve the age of each wait.
    listTasksWhere(ctx, { states: ["queued"] }).filter(t => t.queue)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .forEach((t, i) => updateTask(ctx, t.id, x => {if (x.queue) x.queue.position = i + 1;}));
    return spawned;
  });
}
