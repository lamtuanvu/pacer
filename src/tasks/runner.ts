import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { withLock } from "../core/lock";
import { pidAlive } from "../link/store";
import { readBlocked } from "../executors/blocked";
import { activeHooks } from "../classify/active";
import type { DecisionHooks } from "../classify/hooks";
import { type ProviderCfg, type Strategy, loadStrategy } from "../config/strategy";
import { type Excluded, rankExecutors } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { brokenReason, markBroken, readBroken, repoFingerprint } from "../exec/broken";
import { selectBackend } from "../exec/backend";
import type { AttemptOutcome } from "../exec/direct";
import { killTree } from "../exec/process";
import { exhaustUntil } from "../exec/limits";
import { verifyRepo } from "../exec/verify";
import type { Ctx } from "../types";
import { markExhausted } from "../usage/reactive";
import { listTasks, readTask, updateTask } from "./store";
import { TERMINAL_STATES, type TaskRecord, type TaskResult, type Verification } from "./types";

export const MAX_ATTEMPTS = 3;
const safe = <T>(f: () => Promise<T>, fb: T) => Promise.resolve().then(f).catch(() => fb);

export interface RunnerDeps {
  loadStrategy: (ctx: Ctx) => Strategy;
  computeStatus: (ctx: Ctx, s: Strategy) => Promise<Status>;
  runAttempt?: (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void) => Promise<AttemptOutcome>;
  verifyRepo: (repo: string, acceptance: string | undefined, env: Ctx["env"]) => Promise<Verification>;
  hooks?: DecisionHooks;
}

const DEFAULTS: RunnerDeps = {
  loadStrategy,
  computeStatus: (ctx, s) => computeStatus(ctx, s),
  verifyRepo: (repo, acceptance, env) => verifyRepo(repo, acceptance, env),
};

function finish(ctx: Ctx, id: string, result: TaskResult): TaskRecord {
  const finished = updateTask(ctx, id, (t) => {
    if(t.placement?.mode) {
      const p=t.placement;
      const line=p.mode==="new"?`ran in new worktree ${t.worktree??result.worktree??"(unknown)"} (${p.why})`:`ran in current worktree (${p.why})`;
      result={...result,report:`${line}\n\n${result.report}`};
    }
    t.result = t.state === "stopped" ? { ...result, status: "stopped" } : result;
    t.state = t.result.status;
    delete t.childPid;
  });
  if (finished.state === "done") {
    const seen = new Set<string>([id]);
    let parent = finished.retryOf;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const previous = readTask(ctx, parent);
      if (!previous) break;
      updateTask(ctx, parent, t => { t.dismissed = true; });
      parent = previous.retryOf;
    }
  }
  return finished;
}

const stopped = (ctx: Ctx, id: string) => readTask(ctx, id)?.state === "stopped";

/** Run a delegated task to completion: pick executors, fall back on limits, verify, record the result. */
export async function runTask(ctx: Ctx, id: string, deps: RunnerDeps = DEFAULTS): Promise<TaskRecord> {
  let started = false;
  const initial=readTask(ctx,id);
  if(!initial)throw Error(`unknown task ${id}`);
  const key=(t:TaskRecord)=>{
    let repo=t.brief.repo;try{repo=realpathSync(repo);}catch{}
    return JSON.stringify([repo,t.brief.goal.trim(),t.brief.acceptance?.trim()??""]);
  };
  let duplicate:string|undefined;
  let task=await withLock(ctx,`brief-${createHash("sha256").update(key(initial)).digest("hex")}`,async()=>{
    return updateTask(ctx,id,t=>{
      if(t.state!=="queued")return;
      if(!t.force)duplicate=listTasks(ctx,Infinity).find(other=>other.id!==id&&other.state==="running"&&!!other.runnerPid&&pidAlive(other.runnerPid)&&key(other)===key(t))?.id;
      if(duplicate)return;
      started=true;t.state="running";t.runnerPid=process.pid;
    });
  });
  if(duplicate)return finish(ctx,id,{status:"failed",executor:null,model:null,files:"",report:`same brief is already active in ${duplicate}; use --force only when concurrent work is intended`,backend:"direct"});
  if (!started) {
    return TERMINAL_STATES.includes(task.state)
      ? finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" })
      : task;
  }
  let attemptedExecutor: string | null = null;
  let attemptedModel: string | null = null;
  let attemptedBackend = "direct";
  try {
    const s = deps.loadStrategy(ctx);
    const hooks = deps.hooks ?? activeHooks;
    const kind = await safe(() => hooks.taskKind(ctx, task), task.kind);
    const tried = new Set<string>();
    let excluded: Excluded[] = [];
    let lastLimitReport: string | undefined;
    let requestedUnavailable: string | undefined;
    let lastBroken: { brokenExecutor: string; brokenReason: string } | undefined;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (stopped(ctx, id)) {
        return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
      }
      const now = Date.now() / 1000;
      const st = await deps.computeStatus({ ...ctx, now }, s);
      const blocked = readBlocked({ ...ctx, now });
      const broken = readBroken({ ...ctx, now });
      const byId = Object.fromEntries(st.providers.map((p) => [p.id, { ...p, ...(blocked[p.id] ? {blockedReason:blocked[p.id].reason,blockedUntil:blocked[p.id].until} : {}), ...(broken[p.id] ? { brokenReason: broken[p.id].reason } : {}) }]));
      const ranking = rankExecutors(kind, s, byId);
      excluded = ranking.excluded;
      const rankedIds = ranking.ranked.map((e) => e.id);
      const req = task.requestedExecutor;
      const requested = req && !tried.has(req) && rankedIds.includes(req);
      if (req && !requested && !requestedUnavailable) requestedUnavailable = excluded.find(e => e.id === req)?.reason ?? "not in the routing list";
      const f = requested
        ? rankedIds
        : await safe(() => hooks.filterExecutors(ctx, task, rankedIds, s), rankedIds);
      const ids = Array.isArray(f) ? rankedIds.filter((x) => f.includes(x)) : rankedIds;
      const pick = requested
        ? req!
        : ids.find((e) => !tried.has(e));
      if (!pick) break;
      tried.add(pick);
      const cfg = s.providers[pick];
      attemptedExecutor = pick;
      attemptedModel = cfg.model ?? null;

      if (stopped(ctx, id)) {
        return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
      }
      const onSpawn = (pid: number) => {
        updateTask(ctx, id, (t) => { t.childPid = pid; });
        if (stopped(ctx, id)) killTree(pid, "SIGTERM");
      };
      const backend = deps.runAttempt ? null : await selectBackend(ctx, s);
      attemptedBackend = backend?.id ?? "direct";
      task = updateTask(ctx, id, t => {
        t.executor = pick; t.backend = attemptedBackend; t.attemptStartedAt = Date.now() / 1000;
      });
      const before = await repoFingerprint(ctx, task.brief.repo);
      let out: AttemptOutcome;
      try {
        out = await (deps.runAttempt ?? backend!.runAttempt)(ctx, cfg, task, onSpawn);
      } catch (error) {
        if (!/ENOENT|EACCES|command not found/.test(String(error))) throw error;
        const code = /EACCES/.test(String(error)) ? 126 : 127;
        out = {
          backend: attemptedBackend, report: String(error),
          exec: { code, stdout: "", stderr: String(error), timedOut: false },
          attempt: { executor: pick, model: cfg.model, startedAt: task.attemptStartedAt!, endedAt: Date.now()/1000, exitCode: code, timedOut: false, limitHit: false, log: "" },
        };
      }
      const duration = out.attempt.endedAt - out.attempt.startedAt;
      if (out.backend !== "orca" && out.exec.code !== 0 && !out.exec.timedOut && duration <= 10) {
        const after = await repoFingerprint(ctx, out.worktree ?? task.brief.repo);
        const reason = brokenReason(out.exec, duration, before === null && after === null ? null : before !== null && before === after);
        if (reason) out.attempt.brokenReason = reason;
      }
      attemptedBackend = out.backend ?? attemptedBackend;
      task = updateTask(ctx, id, (t) => {
        t.attempts.push(out.attempt);
        t.backend = attemptedBackend;
        delete t.childPid;
      });
      if (task.state === "stopped") {
        return finish(ctx, id, { status: "stopped", executor: pick, model: cfg.model, files: "", report: out.report, backend: out.backend ?? "direct" });
      }
      if (out.attempt.brokenReason) {
        markBroken({ ...ctx, now: Date.now()/1000 }, pick, out.attempt.brokenReason);
        lastBroken = { brokenExecutor: pick, brokenReason: out.attempt.brokenReason };
        if (pick === task.requestedExecutor) requestedUnavailable = `broken: ${out.attempt.brokenReason}`;
        continue;
      }
      lastBroken = undefined;
      if (out.attempt.limitHit) {
        lastLimitReport = out.report;
        markExhausted(ctx, pick, exhaustUntil(byId[pick], cfg, Date.now() / 1000));
        if (pick === task.requestedExecutor) requestedUnavailable = "limit";
        continue;
      }
      const v = await deps.verifyRepo(out.worktree ?? task.brief.repo, task.brief.acceptance, ctx.env);
      const ok = out.exec.code === 0 && !out.exec.timedOut;
      const changed = !!v.files.trim() && !["(no changes)", "(not a git repository)"].includes(v.files.trim());
      const review = changed && !out.exec.timedOut && out.exec.code > 0 && out.exec.code < 126;
      const status = !ok ? review ? "partial" : "failed" : v.acceptance && !v.acceptance.passed ? "partial" : "done";
      const report = requestedUnavailable ? `requested ${task.requestedExecutor} unavailable (${requestedUnavailable}); ran on ${pick}\n\n${out.report}` : out.report;
      const result: TaskResult = { status, executor: pick, model: cfg.model, ...v, report, backend: out.backend ?? "direct", ...(out.worktree ? { worktree: out.worktree } : {}) };
      const check = await safe(() => hooks.resultCheck(ctx, task, result), undefined);
      return finish(ctx, id, check ? { ...result, check } : result);
    }

    const req = task.requestedExecutor;
    const why = req && !tried.has(req)
      ? `requested executor "${req}" is unavailable (${excluded.find((e) => e.id === req)?.reason ?? "not in the routing list"})`
      : tried.size
        ? `every executor tried hit a limit (${[...tried].join(", ")})`
        : `no executor available (${excluded.map((e) => `${e.id}: ${e.reason}`).join(", ") || "none configured"})`;
    const unavailableBroken = Object.entries(readBroken({ ...ctx, now: Date.now()/1000 })).find(([id]) => (!req || id === req) && excluded.some(e => e.id === id));
    const failure = lastBroken ?? (unavailableBroken && (tried.size === 0 || req === unavailableBroken[0]) ? { brokenExecutor: unavailableBroken[0], brokenReason: unavailableBroken[1].reason } : undefined);
    return finish(ctx, id, { status: failure ? "failed" : "limit", executor: failure?.brokenExecutor ?? attemptedExecutor, model: attemptedModel, files: "", report: failure ? `executor not working: ${failure.brokenReason}` : [why, lastLimitReport].filter(Boolean).join("\n\n"), backend: attemptedBackend, ...failure });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish(ctx, id, { status: "failed", executor: attemptedExecutor, model: attemptedModel, files: "", report: `pacer runner error: ${message}`, backend: attemptedBackend });
  }
}
