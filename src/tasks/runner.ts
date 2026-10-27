import { authorizeRoute } from "./policy-route";
import { getWork, pendingChildren, issueWorkGrant, revokeWorkGrants } from "../dispatch/work";
import { resolveTaskDispatch, reserveDispatch, releaseDispatch, selectedDispatchModel } from "../dispatch/runtime";
import {dispatchSettingsHash} from "../dispatch/learning";
import type { Candidate, DispatchPreview } from "../dispatch/types";
import { ensureRunnerIntegration } from "../core/integrations";
import { beginWorkSync, claimWorkSync, finishWorkSync } from "../update/desktop/admission";
import { restrictEligibility } from "../engine/eligibility";
import { accountEvidenceScope, recordExecutionEvidence } from "../core/evidence";
import { prepareLaunch, launchEvidenceCurrent } from "./eligibility";
import { CoreError } from "../core/errors";
import { executorExclusion } from "../executors/availability";

import { PROJECT_STRATEGIES_LOCK, projectRevision, readProjectStrategies } from "../config/project-strategies";
import { projectSnapshot, requireProjectExecutor } from "../core/project-policy";
import { resolvePolicyRepo, requirePolicyIdentity } from "../core/project-policy";
import { projectPolicy, type ProjectSelection } from "../engine/project-routing";
import { queueCapacity } from "./capacity";
import { persistTaskDiff } from "./diff";
import { slotBlock, slotUse } from "../engine/slots";
import { readPause } from "../core/pause";
import { drainQueue } from "./drain";
import { type SpawnRunner } from "./api";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { gitInfo, realpathSafe } from "../core/git";
import { worktreeUnchanged } from "../supervisor/worktree";
import { withLock } from "../core/lock";
import { pidAlive } from "../link/pid";
import { readBlocked } from "../executors/blocked";
import { activeHooks } from "../classify/active";
import type { DecisionHooks } from "../classify/hooks";
import { type ProviderCfg, type Strategy, loadStrategy } from "../config/strategy";
import { type Excluded, rankExecutors, ruleFor } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { brokenReason, markBroken, readBroken, repoFingerprint } from "../exec/broken";
import { directBackend, selectBackend } from "../exec/backend";
import { type AttemptOutcome, resumeAttempt } from "../exec/direct";
import { killTree } from "../exec/process";
import { resumeOwnedDirect, runOwnedDirectCurrent, runOwnedDirectNew,
  runOwnedDirectRemote } from "../plugins/executor-production";
import { exhaustUntil } from "../exec/limits";
import { verifyRepo } from "../exec/verify";
import type { Ctx } from "../types";
import { validateExecution } from "../config/execution";
import { remoteExclusion } from "../remote/eligibility";
import { resolveRunner } from "../config/runner-id";
import { markAuthFailed, attemptAuthError } from "../usage/auth";
import { markExhausted } from "../usage/reactive";
import { usageRefreshCapability } from "../usage";
import { listTasksWhere, readTask, updateTask, withTaskLock } from "./store";
import { resolvePlacement, TERMINAL_STATES, type AttemptUsage, type RoutingNote, type TaskRecord, type TaskResult, type Verification } from "./types";

export const MAX_ATTEMPTS = 3;
/** Only a structured executor identity is evidence of the model actually used. */
export function observedAttemptModel(runner:string,stdout:string):string|null {
  if(!runner.startsWith("claude-code"))return null;
  for(const line of stdout.split("\n").slice(0,64)){
    try{const event=JSON.parse(line) as Record<string,unknown>;if(event.type==="system"&&event.subtype==="init"&&typeof event.model==="string"&&event.model.length<=256)return event.model;}catch{}
  }
  return null;
}
const safe = <T>(f: () => Promise<T>, fb: T) => Promise.resolve().then(f).catch(() => fb);

export interface RunnerDeps {
  loadStrategy: (ctx: Ctx) => Strategy;
  computeStatus: (ctx: Ctx, s: Strategy, opts?: Parameters<typeof computeStatus>[2]) => Promise<Status>;
  runAttempt?: (ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void) => Promise<AttemptOutcome>;
  verifyRepo: (repo: string, acceptance: string | undefined, env: Ctx["env"]) => Promise<Verification>;
  hooks?: DecisionHooks;
  spawnRunner?: SpawnRunner;
}

const DEFAULTS: RunnerDeps = {
  loadStrategy,
  computeStatus,
  verifyRepo: (repo, acceptance, env) => verifyRepo(repo, acceptance, env),
};

function finish(ctx: Ctx, id: string, result: TaskResult): TaskRecord {
  if (getWork(ctx,id) && result.status === "done" && pendingChildren(ctx,id).length) result = {...result,status:"needs_input",report:result.report+"\nRequired child work needs review before this task can complete."};
  const finished = updateTask(ctx, id, (t) => {
    if (t.executorProvider && t.stopPending) {
      const receipt = t.executorExitReceipt, run = t.run, pending = t.stopPending;
      if (!run || !receipt || receipt.attempt !== pending.attempt ||
        receipt.providerId !== pending.providerId || receipt.dir !== run.dir ||
        receipt.startedAt !== run.startedAt) {
        delete t.runnerPid;
        return;
      }
      const deadline = pending.reason === "deadline";
      result = { ...result, status: deadline ? "failed" : "stopped",
        report: deadline ? "Executor deadline reached; wrapper exit verified" :
          result.report || "Executor exited after stop was requested" };
      delete t.stopPending;
    }
    if(t.placement?.mode && !t.run?.host) {
      const p=t.placement;
      const line=p.mode==="new"?`ran in new worktree ${t.worktree??result.worktree??"(unknown)"} (${p.why})`:`ran in current worktree (${p.why})`;
      result={...result,report:`${line}\n\n${result.report}`};
    }
    t.result = t.state === "stopped" ? { ...result, status: "stopped" } : result;
    t.state = t.result.status;
    if (t.interactionMode === "conversation") t.conversation = {
      ...t.conversation, activity: "ended",
      endReason: t.state === "stopped" ? "user" : t.state === "done" ? "agent_exit" : "failure",
    };
    if (t.takeover) t.takeover.state = "ended";
    delete t.childPid;
    delete t.runnerPid;
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
  const {operation:_requestLifetime,...taskCtx}=ctx;ctx=taskCtx;
  const inherited = ctx.env.PACER_ADMISSION_TASK === id ? ctx.env.PACER_ADMISSION_LEASE : undefined;
  const lease = inherited ?? beginWorkSync(ctx, { kind: "task", id, label: `Task ${id}` });
  const newlyClaimedLease=claimWorkSync(ctx, lease);
  const env = { ...ctx.env }; delete env.PACER_ADMISSION_LEASE; delete env.PACER_ADMISSION_TASK;
  ctx = { ...ctx, env };
  const startedAt = Date.now();
  const ownership={claimed:false};
  try {
    return await runTaskOnce(ctx, id, deps, ownership);
  } finally {
    if(!inherited||newlyClaimedLease||ownership.claimed) finishWorkSync(ctx, lease);
    const current=readTask(ctx,id);
    if (ownership.claimed && getWork(ctx,id) && (current?.runnerPid===process.pid || TERMINAL_STATES.includes(current?.state??"queued"))) {
      releaseDispatch(ctx,id); revokeWorkGrants(ctx,id);
    }
    if (TERMINAL_STATES.includes(readTask(ctx, id)?.state ?? "queued")) {
      await drainQueue({...ctx, now: ctx.now + (Date.now() - startedAt)/1000}, deps.spawnRunner, {
        loadStrategy: deps.loadStrategy, computeStatus: deps.computeStatus, hooks: deps.hooks,
      }).catch(() => {});
    }
  }
}

async function runTaskOnce(ctx: Ctx, id: string, deps: RunnerDeps, ownership:{claimed:boolean}): Promise<TaskRecord> {
  let started = false;
  const initial=readTask(ctx,id);
  if(!initial)throw Error(`unknown task ${id}`);
  const key=(t:TaskRecord)=>{
    let repo=t.brief.repo;try{repo=realpathSync(repo);}catch{}
    return JSON.stringify([repo,t.brief.goal.trim(),t.brief.acceptance?.trim()??""]);
  };
  let duplicate:string|undefined;
  let task=await withLock(ctx,`brief-${createHash("sha256").update(key(initial)).digest("hex")}`,async()=>{
    return withLock(ctx, "slots", async () => withTaskLock(ctx,id,()=>{
      const current=readTask(ctx,id);
      if(!current) throw new Error(`unknown task ${id}`);
      const resumable = current.state === "running" && !!current.run && current.run.attempt > current.attempts.length && !(!!current.runnerPid && pidAlive(current.runnerPid));
      const prepared = current.state === "running" && current.executorProvider === "pacer-exec-direct" &&
        !current.run && !current.stopPending &&
        (!!current.worktreeIntent || !!current.runClaim || !!current.baseFetchIntent?.sha ||
          !!current.remotePrepareIntent);
      const dispatched = current.state === "running" && !current.run &&
        (!current.runnerPid || current.runnerPid === process.pid || !pidAlive(current.runnerPid)) &&
        (!current.attemptStartedAt || prepared);
      if(current.state!=="queued" && !resumable && !dispatched) return current;
      if(current.state === "queued" && current.runnerPid && pidAlive(current.runnerPid) && !current.queue) return current;
      if(!current.force && current.state==="queued") duplicate=listTasksWhere(ctx,{states:["queued","running"]}).find(other=>other.id!==id&&(other.state==="running"||(other.state==="queued"&&!other.queue))&&!!other.runnerPid&&pidAlive(other.runnerPid)&&key(other)===key(current))?.id;
      if(duplicate) return current;
      started=true;
      return updateTask(ctx,id,t=>{
        t.runnerPid=process.pid;delete t.queue;
        if(dispatched) t.attemptStartedAt=Date.now()/1000;
      });
    }));
  });
  ownership.claimed=started;
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
    let s = deps.loadStrategy(ctx);
    const hooks = deps.hooks ?? activeHooks;
    const kind = await safe(() => hooks.taskKind(ctx, task), task.kind);
    const tried = new Set<string>();
    const triedCandidates = new Set<string>();
    const policyExcluded = new Map<string,string>();
    let excluded: Excluded[] = [];
    const remoteSkipped = new Map<string, string>();
    let lastLimitReport: string | undefined;
    let requestedUnavailable: string | undefined;
    let policyChanges = 0;
    let lastBroken: { brokenExecutor: string; brokenReason: string } | undefined;

    const managedWork = getWork(ctx, id);
    const attemptBudget = managedWork
      ? Math.max(0, (managedWork.options.maxAttempts ?? MAX_ATTEMPTS) - task.attempts.length)
      : MAX_ATTEMPTS;
    if (managedWork && attemptBudget === 0) {
      return finish(ctx, id, { status: "limit", executor: task.attempts.at(-1)?.executor ?? null, model: task.attempts.at(-1)?.model ?? null, files: "", report: "Managed work attempt limit reached", backend: attemptedBackend });
    }
    for (let i = 0; i < attemptBudget; i++) {
      const resuming = i === 0 && task.run && task.run.attempt > task.attempts.length ? task.run : null;
      if (resuming && task.executorProvider && task.stopPending)
        return updateTask(ctx, id, current => { if (current.runnerPid === process.pid) delete current.runnerPid; });
      if (resuming && task.executorProvider && task.executorProvider !== "pacer-exec-direct")
        return updateTask(ctx, id, current => { if (current.runnerPid === process.pid) delete current.runnerPid; });
      let selection: ProjectSelection | undefined;
      let policySnapshot: ReturnType<typeof projectSnapshot> | undefined;
      let pick: string | undefined;
      let routing: RoutingNote | undefined;
      let pickReason: string | undefined;
      let startStatus: Status | undefined;
      let applicableIds: string[] = [];
      let decision: DispatchPreview | undefined;
      let dispatchCandidates: Candidate[] = [];
      let routeAdmission: Awaited<ReturnType<typeof authorizeRoute>> | undefined;
      const work = getWork(ctx,id);
      let byId: Record<string, Status["providers"][number]> = {};
      if (resuming) {
        pick = resuming.executor;
      } else {
        if (stopped(ctx, id)) {
          return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
        }
        s = deps.loadStrategy(ctx);
        const repo = task.repo && !task.repo.identityUnverified ? task.repo : await resolvePolicyRepo(ctx, task.brief.repo);
        if (task.repo?.key !== repo.key) task = updateTask(ctx, id, t => { t.repo = repo; });
        const snapshot = projectSnapshot(ctx, s, repo.key);
        policySnapshot = snapshot;
        selection = snapshot.selection;
        if (!tried.has(task.requestedExecutor ?? "")) requireProjectExecutor(selection, task.requestedExecutor);
        const now = Date.now() / 1000;
        const st = await deps.computeStatus({ ...ctx, now }, s, {includePlannerSignIn: task.interactionMode === "conversation"});
        startStatus = st;
        const blocked = readBlocked({ ...ctx, now });
        const broken = readBroken({ ...ctx, now });
        byId = Object.fromEntries(st.providers.map((p) => [p.id, { ...p, ...(blocked[p.id] ? {blockedReason:blocked[p.id].reason,blockedUntil:blocked[p.id].until} : {}), ...(broken[p.id] ? { brokenReason: broken[p.id].reason } : {}) }]));
        for (const p of Object.values(byId)) {
          const reason = executorExclusion({ ...ctx, now }, s, p.id);
          if (reason === "Blocked by you") p.blockedReason = reason;
          if (reason === "exhausted") { p.verdict = "EXHAUSTED"; p.eligibility = restrictEligibility(p.eligibility, "budget_exhausted"); }
        }
        const conversationSelection = task.interactionMode === "conversation" && task.requestedExecutor
          ? {executors: selection?.executors ?? [task.requestedExecutor], order: "configured" as const} : undefined;
        const ranking = rankExecutors(kind, s, byId, conversationSelection ?? (selection && {executors: selection.executors, order: "configured"}),
          {includePlanner: !!work?.options.allowDelegation || task.interactionMode === "conversation"});
        if (work) {
          decision = await resolveTaskDispatch({...ctx,now},task,s,st,triedCandidates,new Set(policyExcluded.keys()));
          if (decision.proposal?.state === "ranked") {
            const ids = decision.proposal.choices.map(c=>c.id);
            dispatchCandidates = ids.flatMap(candidateId=>{const c=decision!.request.candidates.find(c=>c.id===candidateId);return c?[c]:[];});
            const seen = new Set<string>();
            ranking.ranked = dispatchCandidates.flatMap((c,index)=>{if(seen.has(c.runner))return [];seen.add(c.runner);return [{id:c.runner,account:c.account,score:dispatchCandidates.length-index,verdict:byId[c.runner]?.verdict??"UNKNOWN",reason:`dispatch ${decision!.engine.id}: ${decision!.proposal!.state === "ranked" ? decision!.proposal!.step : "selected"}`}];});
          } else ranking.ranked=[];
        }
        // Resolve placement only for a remote candidate; local routing remains
        // unchanged and the backend still owns worktree creation and safety.
        if (ranking.ranked.some(e => resolveRunner(s, e.id)?.host)) {
          const git = await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" }));
          const top = realpathSafe("error" in git ? task.brief.repo : git.top);
          const busy = listTasksWhere(ctx, { states: ["running"] }).some(t => {
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
        ranking.ranked=ranking.ranked.filter(candidate=>!policyExcluded.has(candidate.id));
        for(const [id,plugin] of policyExcluded) excluded.push({id,reason:`excluded by plugin ${plugin}`});
        const rankedIds = ranking.ranked.map(e => e.id);
        const req = task.requestedExecutor;
        const requested = req && !tried.has(req) && rankedIds.includes(req);
        const f = requested ? rankedIds : await safe(() => hooks.filterExecutors(ctx, task, rankedIds, s), rankedIds);
        let allowed = (Array.isArray(f) ? rankedIds.filter(x => f.includes(x)) : rankedIds).filter(id=>!tried.has(id));
        routeAdmission=await authorizeRoute({...ctx,now:Date.now()/1000},id,allowed,{
          strategy:current=>deps.loadStrategy(current),contextFingerprint:()=>JSON.stringify({tried:[...tried],triedCandidates:[...triedCandidates]}),
        });
        allowed=routeAdmission.candidates;
        for(const [candidate,plugin] of Object.entries(routeAdmission.excludedBy)) {
          policyExcluded.set(candidate,plugin);excluded.push({id:candidate,reason:`excluded by plugin ${plugin}`});
        }
        dispatchCandidates=dispatchCandidates.filter(candidate=>allowed.includes(candidate.runner)&&!policyExcluded.has(candidate.runner));
        if(req&&!tried.has(req)&&!allowed.includes(req)&&policyExcluded.has(req)) requestedUnavailable=`excluded by plugin ${policyExcluded.get(req)}`;
        // A model engine may offer only its next choice. Re-run normal routing
        // with the cumulative runner exclusions before reserving anything.
        // Every repeat removes at least one current candidate; no policy-count cap.
        if(work&&Object.keys(routeAdmission.excludedBy).length) {i--;continue;}
        let policyChanged = false;
        await withLock(ctx, "slots", () => withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
          routeAdmission!.revalidate();
          requirePolicyIdentity(ctx, repo);
          if (projectRevision(readProjectStrategies(ctx), repo.key) !== snapshot.rev) { policyChanged = true; return; }
          if (stopped(ctx, id)) return;
          const use = slotUse(listTasksWhere(ctx, { states: ["running"] }).filter(t => t.id !== id));
          const full = new Set<string>();
          ranking.ranked = ranking.ranked.filter(candidate => {
            if (!allowed.includes(candidate.id)) return false;
            const guard = executorExclusion({ ...ctx, now: Date.now() / 1000 }, s, candidate.id);
            if (guard) { excluded.push({ id: candidate.id, reason: guard }); return false; }
            const reason = slotBlock(s, candidate.id, use);
            if (!reason) return true;
            full.add(candidate.id);
            excluded.push({id: candidate.id, reason});
            remoteSkipped.set(candidate.id, reason);
            return false;
          });
          const ids = ranking.ranked.map(e => e.id);
          applicableIds = ids;
          const paused = readPause(ctx);
          if (task.interactionMode === "conversation" && req && !ids.includes(req) && !full.has(req)) {
            task = updateTask(ctx, id, t => {
              routeAdmission!.revalidate();
              t.state = "queued";
              t.queue = {reason: "waiting_retry", detail: excluded.find(e => e.id === req)?.reason ?? "Selected executor is unavailable", since: initial.queue?.since ?? now, position: 1};
              delete t.runnerPid; delete t.executor; delete t.attemptStartedAt;
            });
            return;
          }
          const refusal = req && !tried.has(req) && excluded.find(e => e.id === req && /Blocked by you|exhausted/.test(e.reason));
          if (refusal) throw new Error(`requested executor "${req}" is unavailable (${refusal.reason})`);
          pick = requested && ids.includes(req!) ? req! : ids.find(e => work ? dispatchCandidates.some(c=>c.runner===e&&!triedCandidates.has(c.id)) : !tried.has(e));
          pickReason = ranking.ranked.find(e => e.id === pick)?.reason;
          if (work && pick && decision) {
            const c = dispatchCandidates.find(c=>c.runner===pick);
            if (!c || !reserveDispatch({...ctx,now},id,c,decision)) pick=undefined;
          }
          if (work && !pick && !paused) {
            const expired=work.options.expiresAt!==undefined&&work.options.expiresAt<=now;
            task=updateTask(ctx,id,t=>{
              routeAdmission!.revalidate();
              if(expired||decision?.recommendedAction==="fail"){t.state="failed";t.result={status:"failed",executor:null,model:null,files:"",report:expired?"Work expired in queue":"No dispatch candidate satisfies policy",backend:"direct"};delete t.queue;}
              else {t.state="queued";t.queue={reason:"waiting_retry",detail:"Waiting for dispatch capacity or dependencies",since:initial.queue?.since??now,position:1,nextAt:now+30};}
              delete t.runnerPid;delete t.executor;delete t.attemptStartedAt;
            });return;
          }
          if (paused || (req && !tried.has(req) && full.has(req)) || (!pick && [...full].some(e => !tried.has(e)))) {
            task = updateTask(ctx, id, t => {
              routeAdmission!.revalidate();
              const waiting = listTasksWhere(ctx, { states: ["queued"] }).filter(x => x.id !== id && x.queue && x.createdAt <= t.createdAt);
              t.state = "queued";
              const blockedExecutor = req && full.has(req) ? req : [...full].find(e => !tried.has(e));
              const capacity = !paused && blockedExecutor ? queueCapacity(s, blockedExecutor, use) : undefined;
              t.queue = {...capacity, reason: paused ? "paused" : "no_slot", since: initial.queue?.since ?? now, position: waiting.length + 1};
              delete t.runnerPid;
              delete t.executor;
              delete t.run;
              delete t.attemptStartedAt;
            });
            pick = undefined;
            return;
          }
          if (req && !requested && !requestedUnavailable) requestedUnavailable = excluded.find(e => e.id === req)?.reason ?? "not in the routing list";
          const fallback = req && pick && pick !== req && requestedUnavailable ? { requested: req, reason: requestedUnavailable, executor: pick } : undefined;
          if (pick) task = updateTask(ctx, id, t => {
            routeAdmission!.revalidate();
            t.state = "running"; t.executor = pick; t.attemptStartedAt = now; delete t.queue; delete t.run;
            if (fallback) t.executorFallback = fallback;
          });
          if(pick) routeAdmission!.checkpoint(task);
        }));
        if (policyChanged) {
          if (++policyChanges > 20) throw new Error("Project policy keeps changing; retry once editing is complete");
          i--; continue;
        }
        if (task.queue) return task;
      }
      if (!pick) break;
      if (!resuming) {
        const skipped = new Map(excluded.map(e => [e.id, e.reason]));
        for (const [executor, reason] of remoteSkipped) if (!skipped.has(executor)) skipped.set(executor, reason);
        if (task.requestedExecutor && requestedUnavailable && !skipped.has(task.requestedExecutor)) skipped.set(task.requestedExecutor, requestedUnavailable);
        routing = {
          ...(selection ? { policy: projectPolicy(selection) } : {}),
          kind, kindSource: initial.kind === null ? "classifier" : "brief",
          rule: selection ? "project order" : ruleFor(kind, s).kinds?.join(", ") ?? "everything else", chosen: pick,
          why: [pickReason ?? "available", ...new Set([...remoteSkipped.keys(), ...tried])].map((value, index) => index ? `${value} busy` : value).join("; "),
          skipped: [...skipped].map(([executor, reason]) => ({ executor, reason })),
        };
      }
      if (!resuming) {
        const guard = executorExclusion({ ...ctx, now: Date.now() / 1000 }, s, pick);
        if (guard) {
          excluded.push({ id: pick, reason: guard });
          if (pick === task.requestedExecutor) throw new Error(`requested executor "${pick}" is unavailable (${guard})`);
          tried.add(pick); continue;
        }
      }

      const selectedModel = work ? selectedDispatchModel(ctx,id) : undefined;
      const cfg = selectedModel === undefined ? s.providers[pick] : {...s.providers[pick],model:selectedModel};
      if (!resuming && task.executorProvider && task.executor && task.executor !== pick)
        return updateTask(ctx, id, current => {
          if (current.runnerPid === process.pid) delete current.runnerPid;
        });
      attemptedExecutor = pick;
      if (resuming && !cfg) {
        if (task.executorProvider) return updateTask(ctx, id, current => {
          if (current.runnerPid === process.pid) delete current.runnerPid;
        });
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
      if (!resuming) {
        const selectedRunner = resolveRunner(s, pick);
        if (selectedRunner) await ensureRunnerIntegration(ctx, selectedRunner);
      }
      const backend = resuming || deps.runAttempt ? null : task.interactionMode === "conversation" || work?.options.allowDelegation ? directBackend : await selectBackend(ctx, s, undefined, pick);
      attemptedBackend = backend?.id ?? "direct";
      const localOwnerCandidate = !resuming && !deps.runAttempt && backend?.id === "direct" &&
        ctx.env.PACER_BACKEND !== "orca" && !work && task.interactionMode !== "conversation" &&
        cfg.session !== "interactive" && !resolveRunner(s, pick)?.host &&
        (!task.worktree || !!task.retryOf) &&
        task.attempts.length === 0;
      const localGit = localOwnerCandidate ? await gitInfo(ctx.run, task.brief.repo).catch(() => ({ error: "git unavailable" })) : null;
      const localTop = localGit && !("error" in localGit) ? realpathSafe(localGit.top) : realpathSafe(task.brief.repo);
      const localBusy = localOwnerCandidate && listTasksWhere(ctx, { states: ["running"] }).some(other => {
        const path = realpathSafe(other.worktree ?? other.result?.worktree ?? other.brief.repo);
        return other.id !== task.id && !!other.runnerPid && pidAlive(other.runnerPid) &&
          other.placement?.mode === "current" && (path === localTop || path.startsWith(`${localTop}/`));
      });
      const localPlacement = localOwnerCandidate && task.worktree ?
        { mode: "new" as const, why: "reuse task worktree" } : localOwnerCandidate ? resolvePlacement(task,
        validateExecution(s.execution).worktree, !!localBusy,
        !!localGit && !("error" in localGit) && localGit.dirty) : null;
      const ownedCurrent = localOwnerCandidate && localPlacement?.mode === "current";
      const ownedNew = localOwnerCandidate && localPlacement?.mode === "new" &&
        !!localGit && !("error" in localGit);
      const remoteRunner = resolveRunner(s, pick);
      const ownedRemote = !deps.runAttempt && !work && task.interactionMode !== "conversation" &&
        ctx.env.PACER_BACKEND !== "orca" && !!remoteRunner?.host &&
        !!s.hosts[remoteRunner.host] && s.hosts[remoteRunner.host]!.session !== "full" &&
        validateExecution(s.execution).session !== "pty" && cfg.session !== "interactive" &&
        (!resuming || !!resuming.host);
      const ownedResume = !!resuming && task.executorProvider === "pacer-exec-direct";
      const owned = ownedCurrent || ownedNew || ownedRemote || ownedResume;
      const account = resolveRunner(s, pick)?.account ?? pick;
      const usage = (st: Status | undefined): AttemptUsage => {
        const reading = st?.accounts?.find(a => a.name === account);
        const window=reading?.window??null,resetEpoch=reading?.resetsAt??null,capturedAt=reading?.capturedAt??null;
        const observationId=capturedAt!==null&&window!==null&&resetEpoch!==null?createHash("sha256").update(JSON.stringify([account,window,resetEpoch,capturedAt,reading?.usedPct??null])).digest("hex"):null;
        return { account, usedPct: reading?.usedPct ?? null, window, at: Date.now() / 1000,
          poolId:window!==null?`${account}:${window}`:null,resetEpoch,capturedAt,observationId,stale:reading?.stale??true };
      };
      const usageAtStart = resuming ? task.pendingAttempt?.usageAtStart : usage(startStatus);
      if (resuming) routing = task.pendingAttempt?.routing;
      task = updateTask(ctx, id, t => {
        if(!resuming) routeAdmission!.revalidate();
        t.pendingAttempt = { routing, usageAtStart };
        t.executor = pick; t.backend = attemptedBackend; t.attemptStartedAt = resuming ? t.attemptStartedAt ?? resuming.startedAt : Date.now() / 1000;
      });
      if(!resuming) routeAdmission!.checkpoint(task);
      const before = resuming ? null : await repoFingerprint(ctx, task.brief.repo);
      if (!resuming) {
        const launchCtx = { ...ctx, now: Date.now() / 1000 };
        const currentStrategy = deps.loadStrategy(launchCtx);
        if (JSON.stringify([currentStrategy.runners[pick], currentStrategy.accounts[account]]) !== JSON.stringify([s.runners[pick], s.accounts[account]])) {
          if (++policyChanges > 20) throw new CoreError("conflict", "Executor policy keeps changing; retry once editing is complete");
          i--; continue;
        }
        const prepared = await prepareLaunch(launchCtx, currentStrategy, pick, deps.computeStatus, startStatus);
        const refreshedSelection = selection ? {executors: selection.executors, order: "configured" as const}
          : task.interactionMode === "conversation" && task.requestedExecutor ? {executors: [task.requestedExecutor], order: "configured" as const} : undefined;
        const refreshedRanking = rankExecutors(kind, currentStrategy, Object.fromEntries(prepared.status.providers.map(p => [p.id, p])), refreshedSelection,
          {includePlanner: !!work?.options.allowDelegation || task.interactionMode === "conversation"});
        const candidate = refreshedRanking.ranked.find(e => e.id === pick);
        if (!candidate || prepared.decision.state === "ineligible") {
          const refusal = refreshedRanking.excluded.find(e => e.id === pick && /Blocked by you|exhausted/.test(e.reason));
          if (pick === task.requestedExecutor && refusal) throw new Error(`requested executor "${pick}" is unavailable (${refusal.reason})`);
          excluded.push(...refreshedRanking.excluded);
          tried.add(pick); continue;
        }
        if (!task.requestedExecutor && prepared.decision.state === "uncertain" && refreshedRanking.ranked.some(e => e.eligibility?.state === "eligible" && applicableIds.includes(e.id) && !tried.has(e.id))) {
          if (++policyChanges > 20) throw new CoreError("conflict", "Executor eligibility keeps changing; retry the task");
          i--; continue;
        }
        const refreshedDispatch=work?await resolveTaskDispatch(launchCtx,task,currentStrategy,prepared.status,triedCandidates,new Set(policyExcluded.keys())):undefined;
        const valid = await withLock(ctx, "slots", () => withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
          routeAdmission!.revalidate();
          if (policySnapshot && projectRevision(readProjectStrategies(ctx), policySnapshot.repoKey) !== policySnapshot.rev) return false;
          const latest = deps.loadStrategy(ctx);
          if (JSON.stringify(latest) !== JSON.stringify(currentStrategy)) return false;
          if(work){
            const fresh=refreshedDispatch!;
            const original=dispatchCandidates.find(c=>c.runner===pick);
            const selected=fresh.request.candidates.find(c=>!policyExcluded.has(c.runner)&&routeAdmission!.candidates.includes(c.runner)&&c.id===original?.id&&fresh.proposal?.state==="ranked"&&fresh.proposal.choices.some(choice=>choice.id===c.id));
            const stillEligible=!!selected;
            if(!selected||!stillEligible||!reserveDispatch(launchCtx,id,selected,fresh))return false;
          }
          return launchEvidenceCurrent({ ...ctx, now: Date.now() / 1000 }, prepared)
            && !executorExclusion({ ...ctx, now: Date.now() / 1000 }, currentStrategy, pick!);
        }));
        if (!valid) {
          if (++policyChanges > 20) throw new CoreError("conflict", "Executor evidence changed before dispatch; retry the task");
          i--; continue;
        }
        routing = { ...routing!, eligibility: prepared.decision,
          ...(prepared.decision.state === "uncertain" ? { fallback: "uncertain" as const } : {}),
          why: candidate.reason };
        task = await withLock(ctx, "slots", () => withLock(ctx, PROJECT_STRATEGIES_LOCK, async () => {
          routeAdmission!.revalidate();
          if(policySnapshot && projectRevision(readProjectStrategies(ctx),policySnapshot.repoKey)!==policySnapshot.rev)
            throw new CoreError("conflict","Project policy changed before route commit");
          if(JSON.stringify(deps.loadStrategy(ctx))!==JSON.stringify(currentStrategy))
            throw new CoreError("conflict","Strategy changed before route commit");
          return updateTask(ctx,id,t=>{
            routeAdmission!.revalidate();
            t.pendingAttempt={routing,usageAtStart};
          });
        }));
        routeAdmission!.checkpoint(task);
      }
      tried.add(pick);
      const selectedCandidate = dispatchCandidates.find(c=>c.runner===pick);
      if(selectedCandidate)triedCandidates.add(selectedCandidate.id);
      let executionCtx=ctx;
      if(work?.options.allowDelegation){const token=issueWorkGrant({...ctx,now:Date.now()/1000},id,task.attempts.length+1);executionCtx={...ctx,env:{...ctx.env,PACER_WORK_GRANT:token}};}

      let out: AttemptOutcome;
      try {
        if (owned) {
          if (!ownedResume) task = updateTask(ctx, id, current => {
            current.executorProvider = "pacer-exec-direct";
            if (localPlacement) current.placement = { requested: current.placement?.requested ?? "auto",
              ...current.placement, mode: localPlacement.mode, why: localPlacement.why };
          });
          out = await (ownedRemote ? runOwnedDirectRemote(executionCtx, cfg, task)
            : ownedResume ? resumeOwnedDirect(executionCtx, cfg, task)
              : ownedNew ? runOwnedDirectNew(executionCtx, cfg, task)
              : runOwnedDirectCurrent(executionCtx, cfg, task));
        } else out = resuming ? await resumeAttempt(executionCtx, cfg, task) : await (deps.runAttempt ?? backend!.runAttempt)(executionCtx, cfg, task, onSpawn);
      } catch (error) {
        const latest = readTask(ctx, id);
        if (owned && latest && TERMINAL_STATES.includes(latest.state)) return latest;
        if (owned && latest?.executorProvider === "pacer-exec-direct" &&
          (latest.run || latest.runClaim || latest.worktreeIntent || latest.baseFetchIntent ||
            latest.remotePrepareIntent || latest.startIntent)) {
          return updateTask(ctx, id, current => {
            if (error instanceof CoreError && error.code === "plugin_timeout" &&
              current.run && current.startIntent && !current.stopPending)
              current.stopPending = { attempt: current.run.attempt, requestedAt: Date.now() / 1000,
                providerId: "pacer-exec-direct", graceMs: 5000, reason: "deadline" };
            if (current.runnerPid === process.pid) delete current.runnerPid;
            current.progress = { lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0,
              logBytes: 0, host: current.run?.host ?? current.remotePrepareIntent?.alias ?? "local",
              ...current.progress, phase: "lost-contact", updatedAt: Date.now() / 1000 };
          });
        }
        if (!/ENOENT|EACCES|command not found/.test(String(error))) throw error;
        const code = /EACCES/.test(String(error)) ? 126 : 127;
        out = {
          backend: attemptedBackend, report: String(error),
          exec: { code, stdout: "", stderr: String(error), timedOut: false },
          attempt: { executor: pick, model: cfg.model, startedAt: task.attemptStartedAt!, endedAt: Date.now()/1000, exitCode: code, timedOut: false, limitHit: false, log: "" },
        };
      }
      if (owned) {
        const latest = readTask(ctx, id);
        if (latest && TERMINAL_STATES.includes(latest.state)) return latest;
      }
      if (owned && readTask(ctx, id)?.stopPending) {
        const deadline = readTask(ctx, id)?.stopPending?.reason === "deadline";
        task = updateTask(ctx, id, current => {
          current.attempts.push(out.attempt);
          delete current.pendingAttempt;
          delete current.childPid;
        });
        return finish(ctx, id, { status: deadline ? "failed" : "stopped", executor: pick, model: cfg.model,
          files: "", report: out.report, backend: "direct" });
      }
      if (remoteSkipped.size) {
        const note = [...remoteSkipped].map(([id, reason]) => `skipped ${id}: ${reason}`).join("\n");
        out.report = `${note}\n\n${out.report}`;
        if (existsSync(out.attempt.log)) appendFileSync(out.attempt.log, `\n--- routing\n${note}\n`);
      }
      out.attempt.actualModel=observedAttemptModel(pick,out.exec.stdout);
      const executedRunner = resolveRunner(s, pick);
      const authAccount = executedRunner?.account;
      const outcomeScope = authAccount && s.accounts[authAccount] ? { ...accountEvidenceScope(s.accounts[authAccount], s.hosts), runner: pick, model: out.attempt.model ?? cfg.model ?? "default", host: executedRunner?.host ?? "local" } : undefined;
      const takeover = out.takeover || !!readTask(ctx,id)?.takeover;
      // Only a failed attempt can mean a signed-out CLI; check where the CLI prints, not the agent's report.
      if (!takeover && authAccount && out.attempt.exitCode !== 0 && !out.attempt.timedOut) {
        let log = "";
        try { log = readFileSync(out.attempt.log, "utf8").slice(-4096); } catch { /* Some backends only return output. */ }
        markAuthFailed({...ctx, now: out.attempt.endedAt}, authAccount, `${out.exec.stderr}\n${out.exec.stdout.slice(-2048)}\n${log}`, {attempt: true, scope: outcomeScope});
      }
      if (!takeover && authAccount && s.accounts[authAccount]) {
        const text = `${out.exec.stderr}\n${out.exec.stdout.slice(-2048)}`;
        const classification = out.exec.code === 0 ? "success" : out.attempt.limitHit ? "quota"
          : attemptAuthError.test(text) ? "authentication"
          : /no active (?:subscription|coding.plan)|subscription (?:expired|required|inactive)/i.test(text) ? "subscription" : "task";
        await recordExecutionEvidence({ ...ctx, now: out.attempt.endedAt }, outcomeScope!, {
          endedAt: out.attempt.endedAt, exitCode: out.exec.code, timedOut: out.exec.timedOut, classification,
          ...(classification === "quota" ? { until: exhaustUntil(byId[pick], cfg, out.attempt.endedAt, text) } : {}),
        });
      }
      if (takeover) { delete out.attempt.brokenReason; out.attempt.limitHit = false; }
      const duration = out.attempt.endedAt - out.attempt.startedAt;
      if (!takeover && out.backend !== "orca" && out.exec.code !== 0 && !out.exec.timedOut && duration <= 10) {
        const isolated = !!out.worktree && realpathSafe(out.worktree) !== realpathSafe(task.brief.repo);
        let unchanged: boolean | null;
        if (resuming) unchanged = null;
        else if (isolated) unchanged = await worktreeUnchanged(ctx, out.worktree!, readTask(ctx, id)?.baseSha ?? readTask(ctx, id)?.baseBranch);
        else { const after = await repoFingerprint(ctx, out.worktree ?? task.brief.repo); unchanged = before === null && after === null ? null : before !== null && before === after; }
        const reason = brokenReason(out.exec, duration, unchanged);
        if (reason) out.attempt.brokenReason = reason;
      }
      if(work){releaseDispatch(ctx,id);revokeWorkGrants(ctx,id);}
      if(work)out.attempt.dispatchSettingsHash=dispatchSettingsHash(s,pick);
      out.attempt.routing = routing;
      out.attempt.usageAtStart = usageAtStart;
      const refreshAccounts = s.accounts[account] && usageRefreshCapability(s.accounts[account]) !== "unavailable" ? [account] : [];
      out.attempt.usageAtEnd = usage(await safe(() => deps.computeStatus({ ...ctx, now: Date.now() / 1000 }, s, {refreshAccounts}), undefined));
      attemptedBackend = out.backend ?? attemptedBackend;
      task = updateTask(ctx, id, (t) => {
        t.attempts.push(out.attempt);
        delete t.pendingAttempt;
        t.backend = attemptedBackend;
        delete t.childPid;
      });
      try {
        const result: TaskResult | undefined = out.worktree ? {
          status: "done", executor: pick, model: cfg.model, files: "", report: "",
          backend: attemptedBackend, worktree: out.worktree,
        } : task.result;
        await persistTaskDiff(ctx, { ...task, state: "done", result });
      } catch (error) {
        out.report += `\n\nCould not save review diff: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (task.state === "stopped") {
        return finish(ctx, id, { status: "stopped", executor: pick, model: cfg.model, files: "", report: out.report, backend: out.backend ?? "direct" });
      }
      if (task.interactionMode === "conversation") {
        // Ending a conversation is not a delegated acceptance/review decision.
        return finish(ctx, id, {
          status: out.attempt.limitHit ? "limit" : out.exec.code === 0 ? "done" : "failed",
          executor: pick, model: cfg.model, files: "", report: out.report, backend: attemptedBackend,
          ...(out.worktree ? {worktree: out.worktree} : {}),
        });
      }
      if (task.question && task.question.answer === undefined) {
        const v = out.partial ? {files:"(kept on host)"} : await deps.verifyRepo(out.worktree ?? task.brief.repo, undefined, ctx.env);
        return finish(ctx,id,{status:"needs_input", executor:pick, model:cfg.model, ...v, report:out.report, backend:attemptedBackend, ...(out.worktree ? {worktree:out.worktree} : {})});
      }
      if (out.attempt.brokenReason) {
        markBroken({ ...ctx, now: Date.now()/1000 }, pick, out.attempt.brokenReason);
        lastBroken = { brokenExecutor: pick, brokenReason: out.attempt.brokenReason };
        if (pick === task.requestedExecutor) requestedUnavailable = `broken: ${out.attempt.brokenReason}`;
        if (owned) return finish(ctx, id, { status: "failed", executor: pick,
          model: cfg.model, files: "", report: `executor not working: ${out.attempt.brokenReason}`,
          backend: attemptedBackend, ...lastBroken });
        continue;
      }
      lastBroken = undefined;
      if (out.attempt.limitHit) {
        lastLimitReport = out.report;
        markExhausted({ ...ctx, now: out.attempt.endedAt }, resolveRunner(s, pick)?.account ?? pick, exhaustUntil(byId[pick], cfg, Date.now() / 1000, `${out.exec.stderr}\n${out.exec.stdout}\n${out.report}`), { scope: outcomeScope });
        if (pick === task.requestedExecutor) requestedUnavailable = "limit";
        if (owned) return finish(ctx, id, { status: "limit", executor: pick,
          model: cfg.model, files: "", report: out.report, backend: attemptedBackend });
        continue;
      }
      if (!out.partial) task = updateTask(ctx, id, t => {
        const now = Date.now() / 1000;
        t.progress = {
          lastOutputAt: null, lastChangeAt: null, files: 0, commits: 0, logBytes: 0,
          host: task.run?.host ?? "local",
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
      : tried.size >= MAX_ATTEMPTS
        ? `attempt limit reached (${MAX_ATTEMPTS}); every executor tried hit a limit (${[...tried].join(", ")})`
      : tried.size
        ? `every executor tried hit a limit (${[...tried].join(", ")})`
        : `no executor available (${excluded.map((e) => `${e.id}: ${e.reason}`).join(", ") || "none configured"})`;
    const unavailableBroken = Object.entries(readBroken({ ...ctx, now: Date.now()/1000 })).find(([id]) => (!req || id === req) && excluded.some(e => e.id === id));
    const failure = lastBroken ?? (unavailableBroken && (tried.size === 0 || req === unavailableBroken[0]) ? { brokenExecutor: unavailableBroken[0], brokenReason: unavailableBroken[1].reason } : undefined);
    return finish(ctx, id, { status: failure || !excluded.some(e => e.reason === "exhausted" || e.eligibility?.budget === "exhausted") && !lastLimitReport ? "failed" : "limit", executor: failure?.brokenExecutor ?? attemptedExecutor, model: attemptedModel, files: "", report: failure ? `executor not working: ${failure.brokenReason}` : [why, lastLimitReport].filter(Boolean).join("\n\n"), backend: attemptedBackend, ...failure });
  } catch (error) {
    const message = error instanceof CoreError ? [error.message, error.hint].filter(Boolean).join(". ") : error instanceof Error ? error.message : String(error);
    return finish(ctx, id, { status: "failed", executor: attemptedExecutor, model: attemptedModel, files: "", report: `pacer runner error: ${message}`, backend: attemptedBackend });
  }
}
