import { type ProviderCfg, type Strategy, loadStrategy } from "../config/strategy";
import { type Excluded, rankExecutors } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { type AttemptOutcome, runAttempt } from "../exec/direct";
import { exhaustUntil } from "../exec/limits";
import { verifyRepo } from "../exec/verify";
import type { Ctx } from "../types";
import { markExhausted } from "../usage/reactive";
import { readTask, updateTask } from "./store";
import type { TaskRecord, TaskResult, Verification } from "./types";

export const MAX_ATTEMPTS = 3;

export interface RunnerDeps {
  loadStrategy: (ctx: Ctx) => Strategy;
  computeStatus: (ctx: Ctx, s: Strategy) => Promise<Status>;
  runAttempt: (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void) => Promise<AttemptOutcome>;
  verifyRepo: (repo: string, acceptance: string | undefined, env: Ctx["env"]) => Promise<Verification>;
}

const DEFAULTS: RunnerDeps = {
  loadStrategy,
  computeStatus: (ctx, s) => computeStatus(ctx, s),
  runAttempt,
  verifyRepo: (repo, acceptance, env) => verifyRepo(repo, acceptance, env),
};

function finish(ctx: Ctx, id: string, result: TaskResult): TaskRecord {
  return updateTask(ctx, id, (t) => {
    t.state = result.status;
    t.result = result;
    delete t.childPid;
  });
}

const stopped = (ctx: Ctx, id: string) => readTask(ctx, id)?.state === "stopped";

/** Run a delegated task to completion: pick executors, fall back on limits, verify, record the result. */
export async function runTask(ctx: Ctx, id: string, deps: RunnerDeps = DEFAULTS): Promise<TaskRecord> {
  let task = updateTask(ctx, id, (t) => {
    t.state = "running";
    t.runnerPid = process.pid;
  });
  const s = deps.loadStrategy(ctx);
  const tried = new Set<string>();
  let excluded: Excluded[] = [];

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (stopped(ctx, id)) {
      return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
    }
    const now = Date.now() / 1000;
    const st = await deps.computeStatus({ ...ctx, now }, s);
    const byId = Object.fromEntries(st.providers.map((p) => [p.id, p]));
    const ranking = rankExecutors(task.kind, s, byId);
    excluded = ranking.excluded;
    const ids = ranking.ranked.map((e) => e.id);
    const pick = task.requestedExecutor
      ? (ids.includes(task.requestedExecutor) && !tried.has(task.requestedExecutor) ? task.requestedExecutor : undefined)
      : ids.find((e) => !tried.has(e));
    if (!pick) break;
    tried.add(pick);
    const cfg = s.providers[pick];

    const out = await deps.runAttempt(ctx, cfg, task, (pid) => updateTask(ctx, id, (t) => { t.childPid = pid; }));
    task = updateTask(ctx, id, (t) => {
      t.attempts.push(out.attempt);
      delete t.childPid;
    });
    if (task.state === "stopped") {
      return finish(ctx, id, { status: "stopped", executor: pick, model: cfg.model, files: "", report: out.report, backend: "direct" });
    }
    if (out.attempt.limitHit) {
      markExhausted(ctx, pick, exhaustUntil(byId[pick], cfg, Date.now() / 1000));
      if (task.requestedExecutor) break;
      continue;
    }
    const v = await deps.verifyRepo(task.brief.repo, task.brief.acceptance, ctx.env);
    const ok = out.exec.code === 0 && !out.exec.timedOut;
    const status = !ok ? "failed" : v.acceptance && !v.acceptance.passed ? "partial" : "done";
    return finish(ctx, id, { status, executor: pick, model: cfg.model, ...v, report: out.report, backend: "direct" });
  }

  const req = task.requestedExecutor;
  const why = req && !tried.has(req)
    ? `requested executor "${req}" is unavailable (${excluded.find((e) => e.id === req)?.reason ?? "not in the routing list"})`
    : tried.size
      ? `every executor tried hit a limit (${[...tried].join(", ")})`
      : `no executor available (${excluded.map((e) => `${e.id}: ${e.reason}`).join(", ") || "none configured"})`;
  return finish(ctx, id, { status: "limit", executor: null, model: null, files: "", report: why, backend: "direct" });
}
