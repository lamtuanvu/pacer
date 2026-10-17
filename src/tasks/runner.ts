import { slotBlock, slotUse } from "../engine/slots";
import { readPause } from "../core/pause";
import { drainQueue } from "./drain";
import { type SpawnRunner } from "./api";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { gitInfo, realpathSafe } from "../core/git";
import { worktreeUnchanged } from "../supervisor/worktree";
import { withLock } from "../core/lock";
import { pidAlive } from "../link/store";
import { readBlocked } from "../executors/blocked";
import { activeHooks } from "../classify/active";
import type { DecisionHooks } from "../classify/hooks";
import { type ProviderCfg, type Strategy, loadStrategy } from "../config/strategy";
import { type Excluded, rankExecutors, ruleFor } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { brokenReason, markBroken, readBroken, repoFingerprint } from "../exec/broken";
import { selectBackend } from "../exec/backend";
import { type AttemptOutcome, resumeAttempt } from "../exec/direct";
import { killTree } from "../exec/process";
import { exhaustUntil } from "../exec/limits";
import { verifyRepo } from "../exec/verify";
import type { Ctx } from "../types";
import { validateExecution } from "../config/execution";
import { remoteExclusion } from "../remote/eligibility";
import { resolveRunner } from "../config/runner-id";
import { markAuthFailed } from "../usage/auth";
import { markExhausted } from "../usage/reactive";
import { listTasks, readTask, updateTask } from "./store";
import { resolvePlacement, TERMINAL_STATES, type AttemptUsage, type RoutingNote, type TaskRecord, type TaskResult, type Verification } from "./types";

export const MAX_ATTEMPTS = 3;
const safe = <T>(f: () => Promise<T>, fb: T) => Promise.resolve().then(f).catch(() => fb);

export interface RunnerDeps {
  loadStrategy: (ctx: Ctx) => Strategy;
  computeStatus: (ctx: Ctx, s: Strategy) => Promise<Status>;
  runAttempt?: (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void) => Promise<AttemptOutcome>;
  verifyRepo: (repo: string, acceptance: string | undefined, env: Ctx["env"]) => Promise<Verification>;
  hooks?: DecisionHooks;
  spawnRunner?: SpawnRunner;
}

const DEFAULTS: RunnerDeps = {
  loadStrategy,
  computeStatus: (ctx, s) => computeStatus(ctx, s),
  verifyRepo: (repo, acceptance, env) => verifyRepo(repo, acceptance, env),
};

function finish(ctx: Ctx, id: string, result: TaskResult): TaskRecord {
  const finished = updateTask(ctx, id, (t) => {
    if(t.placement?.mode && !t.run?.host) {
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
  const startedAt = Date.now();
  try {
    return await runTaskOnce(ctx, id, deps);
  } finally {
    if (TERMINAL_STATES.includes(readTask(ctx, id)?.state ?? "queued")) {
      await drainQueue({...ctx, now: ctx.now + (Date.now() - startedAt)/1000}, deps.spawnRunner, {
        loadStrategy: deps.loadStrategy, computeStatus: deps.computeStatus, hooks: deps.hooks,
      }).catch(() => {});
    }
  }
}

async function runTaskOnce(ctx: Ctx, id: string, deps: RunnerDeps): Promise<TaskRecord> {
  let started = false;
  const initial=readTask(ctx,id);
  if(!initial)throw Error(`unknown task ${id}`);
  const key=(t:TaskRecord)=>{
    let repo=t.brief.repo;try{repo=realpathSync(repo);}catch{}
    return JSON.stringify([repo,t.brief.goal.trim(),t.brief.acceptance?.trim()??""]);
  };
  let duplicate:string|undefined;
  let task=await withLock(ctx,`brief-${createHash("sha256").update(key(initial)).digest("hex")}`,async()=>{
    return withLock(ctx, "slots", async () => updateTask(ctx,id,t=>{
      const resumable = t.state === "running" && !!t.run && t.run.attempt > t.attempts.length && !(!!t.runnerPid && pidAlive(t.runnerPid));
      const dispatched = t.state === "running" && !t.attemptStartedAt && !t.run && (!t.runnerPid || t.runnerPid === process.pid || !pidAlive(t.runnerPid));
      if(t.state!=="queued" && !resumable && !dispatched)return;
      if(t.state === "queued" && t.runnerPid && pidAlive(t.runnerPid) && !t.queue)return;
      if(!t.force && t.state==="queued")duplicate=listTasks(ctx,Infinity).find(other=>other.id!==id&&(other.state==="running" || (other.state==="queued" && !other.queue))&&!!other.runnerPid&&pidAlive(other.runnerPid)&&key(other)===key(t))?.id;
      if(duplicate)return;
      started=true;t.runnerPid=process.pid;delete t.queue;
      if (dispatched) t.attemptStartedAt = Date.now()/1000;
    }));
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
    const remoteSkipped = new Map<string, string>();
    let lastLimitReport: string | undefined;
    let requestedUnavailable: string | undefined;
    let lastBroken: { brokenExecutor: string; brokenReason: string } | undefined;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const resuming = i === 0 && task.run && task.run.attempt > task.attempts.length ? task.run : null;
      let pick: string | undefined;
      let routing: RoutingNote | undefined;
      let pickReason: string | undefined;
      let startStatus: Status | undefined;
      let byId: Record<string, Status["providers"][number]> = {};
      if (resuming) {
        pick = resuming.executor;
      } else {
        if (stopped(ctx, id)) {
          return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
        }
        const now = Date.now() / 1000;
        const st = await deps.computeStatus({ ...ctx, now }, s);
        startStatus = st;
        const blocked = readBlocked({ ...ctx, now });
        const broken = readBroken({ ...ctx, now });
        byId = Object.fromEntries(st.providers.map((p) => [p.id, { ...p, ...(blocked[p.id] ? {blockedReason:blocked[p.id].reason,blockedUntil:blocked[p.id].until} : {}), ...(broken[p.id] ? { brokenReason: broken[p.id].reason } : {}) }]));
        const ranking = rankExecutors(kind, s, byId);
        // Resolve placement only for a remote candidate; local routing remains
        // unchanged and the backend still owns worktree creation and safety.
        if (ranking.ranked.some(e => resolveRunner(s, e.id)?.host)) {
          const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
          const top = realpathSafe("error" in git ? task.brief.repo : git.top);
          const busy = listTasks(ctx, Infinity).some(t => {
            const path = realpathSafe(t.worktree ?? t.result?.worktree ?? t.brief.repo);
            return t.id !== task.id && t.state === "running" && !!t.runnerPid && pidAlive(t.runnerPid)
              && t.placement?.mode === "current" && (path === top || path.startsWith(top + "/"));
          });
          const placement = task.placement?.mode ?? resolvePlacement(task, validateExecution(s.execution).worktree, busy, !("error" in git) && git.dirty).mode;
          const eligible = [];
          for (const candidate of ranking.ranked) {
            const reason = await remoteExclusion({ ...ctx, now }, s, candidate.id, { repo: task.brief.repo, placement }, {skipSlots: true});
            if (reason) {
              ranking.excluded.push({ id: candidate.id, ...(candidate.account ? { account: candidate.account } : {}), reason });
              remoteSkipped.set(candidate.id, reason);
            } else eligible.push(candidate);
          }
          ranking.ranked = eligible;
        }
        excluded = ranking.excluded;
        const rankedIds = ranking.ranked.map(e => e.id);
        const req = task.requestedExecutor;
        const requested = req && !tried.has(req) && rankedIds.includes(req);
        const f = requested ? rankedIds : await safe(() => hooks.filterExecutors(ctx, task, rankedIds, s), rankedIds);
        const allowed = Array.isArray(f) ? rankedIds.filter(x => f.includes(x)) : rankedIds;
        await withLock(ctx, "slots", async () => {
          if (stopped(ctx, id)) return;
          const use = slotUse(listTasks(ctx, Infinity).filter(t => t.id !== id));
          const full = new Set<string>();
          ranking.ranked = ranking.ranked.filter(candidate => {
            if (!allowed.includes(candidate.id)) return false;
            const reason = slotBlock(s, candidate.id, use);
            if (!reason) return true;
            full.add(candidate.id);
            excluded.push({id: candidate.id, reason});
            remoteSkipped.set(candidate.id, reason);
            return false;
          });
          const ids = ranking.ranked.map(e => e.id);
          const paused = readPause(ctx);
          pick = requested && ids.includes(req!) ? req! : ids.find(e => !tried.has(e));
          pickReason = ranking.ranked.find(e => e.id === pick)?.reason;
          if (paused || (req && !tried.has(req) && full.has(req)) || (!pick && [...full].some(e => !tried.has(e)))) {
            task = updateTask(ctx, id, t => {
              const waiting = listTasks(ctx, Infinity).filter(x => x.id !== id && x.state === "queued" && x.queue && x.createdAt <= t.createdAt);
              t.state = "queued";
              t.queue = {reason: paused ? "paused" : "no_slot", since: initial.queue?.since ?? now, position: waiting.length + 1};
              delete t.runnerPid;
              delete t.executor;
              delete t.run;
              delete t.attemptStartedAt;
            });
            pick = undefined;
            return;
          }
          if (req && !requested && !requestedUnavailable) requestedUnavailable = excluded.find(e => e.id === req)?.reason ?? "not in the routing list";
          if (pick) task = updateTask(ctx, id, t => {t.state = "running"; t.executor = pick; t.attemptStartedAt = now; delete t.queue; delete t.run;});
        });
        if (task.queue) return task;
      }
      if (!pick) break;
      if (!resuming) {
        const skipped = new Map(excluded.map(e => [e.id, e.reason]));
        for (const [executor, reason] of remoteSkipped) if (!skipped.has(executor)) skipped.set(executor, reason);
        if (task.requestedExecutor && requestedUnavailable && !skipped.has(task.requestedExecutor)) skipped.set(task.requestedExecutor, requestedUnavailable);
        routing = {
          kind, kindSource: initial.kind === null ? "classifier" : "brief",
          rule: ruleFor(kind, s).kinds?.join(", ") ?? "everything else", chosen: pick,
          why: [pickReason ?? "available", ...new Set([...remoteSkipped.keys(), ...tried])].map((value, index) => index ? `${value} busy` : value).join("; "),
          skipped: [...skipped].map(([executor, reason]) => ({ executor, reason })),
        };
      }
      tried.add(pick);
      const cfg = s.providers[pick];
      attemptedExecutor = pick;
      if (resuming && !cfg) {
        return finish(ctx, id, { status: "failed", executor: pick, model: null, files: "", report: `cannot resume: executor ${pick} is no longer configured`, backend: "direct" });
      }
      attemptedModel = cfg.model ?? null;

      if (!resuming && stopped(ctx, id)) {
        return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
      }
      const onSpawn = (pid: number) => {
        updateTask(ctx, id, (t) => { t.childPid = pid; });
        if (stopped(ctx, id) && !resolveRunner(s, pick!)?.host) killTree(pid, "SIGTERM");
      };
      const backend = resuming || deps.runAttempt ? null : await selectBackend(ctx, s, undefined, pick);
      attemptedBackend = backend?.id ?? "direct";
      const account = resolveRunner(s, pick)?.account ?? pick;
      const usage = (st: Status | undefined): AttemptUsage => {
        const reading = st?.accounts?.find(a => a.name === account);
        return { account, usedPct: reading?.usedPct ?? null, window: reading?.window ?? null, at: Date.now() / 1000 };
      };
      const usageAtStart = resuming ? task.pendingAttempt?.usageAtStart : usage(startStatus);
      if (resuming) routing = task.pendingAttempt?.routing;
      task = updateTask(ctx, id, t => {
        t.pendingAttempt = { routing, usageAtStart };
        t.executor = pick; t.backend = attemptedBackend; t.attemptStartedAt = resuming?.startedAt ?? Date.now() / 1000;
      });
      const before = resuming ? null : await repoFingerprint(ctx, task.brief.repo);
      let out: AttemptOutcome;
      try {
        out = resuming ? await resumeAttempt(ctx, cfg, task) : await (deps.runAttempt ?? backend!.runAttempt)(ctx, cfg, task, onSpawn);
      } catch (error) {
        if (!/ENOENT|EACCES|command not found/.test(String(error))) throw error;
        const code = /EACCES/.test(String(error)) ? 126 : 127;
        out = {
          backend: attemptedBackend, report: String(error),
          exec: { code, stdout: "", stderr: String(error), timedOut: false },
          attempt: { executor: pick, model: cfg.model, startedAt: task.attemptStartedAt!, endedAt: Date.now()/1000, exitCode: code, timedOut: false, limitHit: false, log: "" },
        };
      }
      if (remoteSkipped.size) {
        const note = [...remoteSkipped].map(([id, reason]) => `skipped ${id}: ${reason}`).join("\n");
        out.report = `${note}\n\n${out.report}`;
        if (existsSync(out.attempt.log)) appendFileSync(out.attempt.log, `\n--- routing\n${note}\n`);
      }
      const authAccount = resolveRunner(s, pick)?.account;
      // Only a failed attempt can mean a signed-out CLI; check where the CLI prints, not the agent's report.
      if (authAccount && out.attempt.exitCode !== 0) {
        let log = "";
        try { log = readFileSync(out.attempt.log, "utf8").slice(-4096); } catch { /* Some backends only return output. */ }
        markAuthFailed({...ctx, now: out.attempt.endedAt}, authAccount, `${out.exec.stderr}\n${out.exec.stdout.slice(-2048)}\n${log}`, {attempt: true});
      }
      const duration = out.attempt.endedAt - out.attempt.startedAt;
      if (out.backend !== "orca" && out.exec.code !== 0 && !out.exec.timedOut && duration <= 10) {
        const isolated = !!out.worktree && realpathSafe(out.worktree) !== realpathSafe(task.brief.repo);
        let unchanged: boolean | null;
        if (resuming) unchanged = null;
        else if (isolated) unchanged = await worktreeUnchanged(ctx, out.worktree!, readTask(ctx, id)?.baseBranch);
        else { const after = await repoFingerprint(ctx, out.worktree ?? task.brief.repo); unchanged = before === null && after === null ? null : before !== null && before === after; }
        const reason = brokenReason(out.exec, duration, unchanged);
        if (reason) out.attempt.brokenReason = reason;
      }
      out.attempt.routing = routing;
      out.attempt.usageAtStart = usageAtStart;
      out.attempt.usageAtEnd = usage(await safe(() => deps.computeStatus({ ...ctx, now: Date.now() / 1000 }, s), undefined));
      attemptedBackend = out.backend ?? attemptedBackend;
      task = updateTask(ctx, id, (t) => {
        t.attempts.push(out.attempt);
        delete t.pendingAttempt;
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
        markExhausted(ctx, resolveRunner(s, pick)?.account ?? pick, exhaustUntil(byId[pick], cfg, Date.now() / 1000, `${out.exec.stderr}\n${out.exec.stdout}\n${out.report}`));
        if (pick === task.requestedExecutor) requestedUnavailable = "limit";
        continue;
      }
      if (!out.partial) task = updateTask(ctx, id, t => {
        const now = Date.now() / 1000;
        t.progress = {
          lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0, logBytes: 0, host: "local",
          ...t.progress, phase: "testing", updatedAt: now,
        };
      });
      const v: Verification = out.partial ? { files: "(kept on host)" } : await deps.verifyRepo(out.worktree ?? task.brief.repo, task.brief.acceptance, ctx.env);
      const ok = out.exec.code === 0 && !out.exec.timedOut;
      const changed = !!v.files.trim() && !["(no changes)", "(not a git repository)"].includes(v.files.trim());
      const review = changed && !out.exec.timedOut && out.exec.code > 0 && out.exec.code < 126;
      const status = out.partial ? "partial" : !ok ? review ? "partial" : "failed" : v.acceptance && !v.acceptance.passed ? "partial" : "done";
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
