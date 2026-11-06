import { loadStrategy } from "../config/strategy";
import { listRepos } from "../core/repos";
import { listJobs } from "../jobs/registry";
import { readHostCheck } from "../remote/hosts";
import { readHostReachability } from "../remote/eligibility";
import { listActiveAndRecentTasks, listTasksWhere } from "../tasks/store";
import type { Ctx } from "../types";

function reachabilityByAlias(ctx: Ctx) {
  const hosts = loadStrategy(ctx).hosts;
  const out: Record<string, ReturnType<typeof readHostReachability>> = {};
  for (const host of Object.values(hosts)) out[host.alias] = readHostReachability(ctx, host);
  return out;
}

function storedByAlias(ctx: Ctx) {
  const hosts = loadStrategy(ctx).hosts;
  const out: Record<string, ReturnType<typeof readHostCheck>> = {};
  for (const host of Object.values(hosts)) {
    const stored = readHostCheck(ctx, host.alias);
    if (stored) out[host.alias] = stored;
  }
  return out;
}

/** Runtime snapshots for native `host.list` / `host.get` (Rust composes via lifecycle hosts). */
export function hostReadParts(ctx: Ctx, alias?: string) {
  const strategy = loadStrategy(ctx);
  const weekAgo = ctx.now - 7 * 86400;
  const seen = new Set<string>();
  const tasks = [];
  for (const task of [
    ...listTasksWhere(ctx, { states: ["running"] }),
    ...listTasksWhere(ctx, { states: ["done"], updatedSince: weekAgo }),
  ]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    tasks.push(task);
  }
  const base = {
    now: ctx.now,
    hosts: strategy.hosts,
    reachabilityByAlias: reachabilityByAlias(ctx),
    storedByAlias: storedByAlias(ctx),
    jobs: listJobs(ctx),
    runners: Object.values(strategy.runners),
    repos: listRepos(ctx),
    tasks,
  };
  if (!alias) return base;
  return { ...base, alias };
}

/** Executors and other read-model fields TypeScript still owns for `host.get`. */
export async function hostReadDetailParts(ctx: Ctx, alias: string) {
  const [{ buildExecutors }, { snapshotTasks }, { computeStatus }] = await Promise.all([
    import("./read-model/capacity"),
    import("./read-model/tasks"),
    import("../engine/status"),
  ]);
  const strategy = loadStrategy(ctx);
  const status = await computeStatus({ ...ctx, readOnly: true }, strategy);
  const executors = buildExecutors(
    status,
    strategy,
    snapshotTasks(ctx, listActiveAndRecentTasks(ctx)),
    ctx.now,
    ctx,
  ).filter(e => e.host === alias);
  return { ...hostReadParts(ctx, alias), enrichment: { executors } };
}
