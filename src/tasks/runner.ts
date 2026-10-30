import { authorizeRoute } from "./policy-route";
import { autoCleanTask } from "./cleanup";
import { getWork, pendingChildren, issueWorkGrant, revokeWorkGrants } from "../dispatch/work";
import { issueEnforcementToken, revokeEnforcementTokens } from "../dispatch/enforcement-token";
import { certificateEvidence, enforcementExclusion, resolveEnforcementTarget, STRICT_INTERACTIVE_REASON } from "../dispatch/enforcement";
import { appendWorkEvent, dispatchDatabase, updateWorkDecision } from "../dispatch/store";
import { extractAttemptTokens } from "../tokens/extract";
import { attemptUsageText, recordAttemptUsage } from "../tokens/store";
import { resolveTaskDispatch, reserveDispatch, releaseDispatch, selectedDispatchModel } from "../dispatch/runtime";
import {dispatchSettingsHash} from "../dispatch/learning";
import type { Candidate, DispatchPreview } from "../dispatch/types";
import { ensureRunnerIntegration } from "../core/integrations";
import { beginWorkSync, claimWorkSync, finishWorkSync } from "../update/desktop/admission";
import { installHandoverHandler, registerRunnerLease } from "./handover";
import { appendActivity } from "../activity/log";
import { currentVersion } from "../update/version";
import { processIdentity } from "../update/desktop/process-identity";
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
import { SLOT_STATES, localMachineGuard, slotBlock, slotUse } from "../engine/slots";
import { readPause } from "../core/pause";
import { drainQueue } from "./drain";
import { type SpawnRunner } from "./api";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitInfo, realpathSafe } from "../core/git";
import { worktreeUnchanged } from "../supervisor/worktree";
import { withLock } from "../core/lock";
import { pidAlive } from "../link/pid";
import { readBlocked } from "../executors/blocked";
import { activeHooks } from "../classify/active";
import type { DecisionHooks } from "../classify/hooks";
import { type ProviderCfg, type Strategy, loadStrategy } from "../config/strategy";
import { conversationFallback, type Excluded, rankExecutors, ruleFor } from "../engine/rank";
import { type Status, computeStatus } from "../engine/status";
import { terminalEnv } from "../exec/login-env";
import { brokenReason, markBroken, readBroken, repoFingerprint } from "../exec/broken";
import { directBackend, selectBackend } from "../exec/backend";
import { type AttemptOutcome, resumeAttempt } from "../exec/direct";
import { killTree } from "../exec/process";
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
  verifyRepo: (repo: string, acceptance: string | undefined, env: Ctx["env"], timeoutMs?: number, pipefail?: boolean) => Promise<Verification>;
  hooks?: DecisionHooks;
  spawnRunner?: SpawnRunner;
}

const DEFAULTS: RunnerDeps = {
  loadStrategy,
  computeStatus,
  verifyRepo,
};

/**
 * An interactive lane (delegate --interactive) runs on any backend; Orca keeps its worker live for answers and
 * `task.send`. A chat from session.create stays on the direct backend, because session.io streams only that PTY.
 * Strict enforcement forces direct for both.
 */
export function needsDirectBackend(task: TaskRecord, strict: boolean): boolean {
  return strict || (task.interactionMode === "conversation" && !task.interactive);
}

function finish(ctx: Ctx, id: string, result: TaskResult): TaskRecord {
  if (getWork(ctx,id) && result.status === "done" && pendingChildren(ctx,id).length) result = {...result,status:"needs_input",report:result.report+"\nRequired child work needs review before this task can complete."};
  const finished = updateTask(ctx, id, (t) => {
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
    delete t.childIdentity;
    delete t.runnerPid;
    delete t.handover;
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

/** The runner whose explicit `session: interactive` alone blocks strict work: the requested one, or every runner. */
function strictInteractiveRefusal(decision: DispatchPreview, requested: string | null): string | undefined {
  if (requested) return decision.excluded.find(e => e.id === requested && e.reason === STRICT_INTERACTIVE_REASON)?.id;
  const blocking = decision.excluded.filter(e => e.reason !== "planner");
  return blocking.length && !decision.request.candidates.length && blocking.every(e => e.reason === STRICT_INTERACTIVE_REASON) ? blocking[0].id : undefined;
}

/** Run a delegated task to completion: pick executors, fall back on limits, verify, record the result. */
export async function runTask(ctx: Ctx, id: string, deps: RunnerDeps = DEFAULTS): Promise<TaskRecord> {
  const {operation:_requestLifetime,...taskCtx}=ctx;ctx=taskCtx;
  const inherited = ctx.env.PACER_ADMISSION_TASK === id ? ctx.env.PACER_ADMISSION_LEASE : undefined;
  const lease = inherited ?? beginWorkSync(ctx, { kind: "task", id, label: `Task ${id}` });
  const newlyClaimedLease=claimWorkSync(ctx, lease);
  installHandoverHandler();
  registerRunnerLease(lease);
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
      releaseDispatch(ctx,id); revokeWorkGrants(ctx,id); revokeEnforcementTokens(ctx,id);
    }
    if (TERMINAL_STATES.includes(readTask(ctx, id)?.state ?? "queued")) {
      await autoCleanTask(ctx, id);
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
      const resumable = (current.state === "running" || (current.state === "stopped" && current.handover?.state === "handed-over")) && !!current.run && current.run.attempt > current.attempts.length && !(!!current.runnerPid && pidAlive(current.runnerPid));
      const dispatched = current.state === "running" && !current.attemptStartedAt && !current.run && (!current.runnerPid || current.runnerPid === process.pid || !pidAlive(current.runnerPid));
      if(current.state!=="queued" && !resumable && !dispatched) return current;
      if(current.state === "queued" && current.runnerPid && pidAlive(current.runnerPid) && !current.queue) return current;
      if(!current.force && current.state==="queued") duplicate=listTasksWhere(ctx,{states:["queued","running"]}).find(other=>other.id!==id&&(other.state==="running"||(other.state==="queued"&&!other.queue))&&!!other.runnerPid&&pidAlive(other.runnerPid)&&key(other)===key(current))?.id;
      if(duplicate) return current;
      started=true;
      return updateTask(ctx,id,t=>{
        t.runnerPid=process.pid;t.runnerPacer=currentVersion();delete t.queue;
        if(dispatched) t.attemptStartedAt=Date.now()/1000;
      });
    }));
  });
  ownership.claimed=started;
  const handedOver = started && task.handover?.state === "handed-over" && !!task.run && task.run.attempt > task.attempts.length ? task.handover : undefined;
  if (handedOver) appendActivity({ ...ctx, now: Date.now() / 1000 }, { kind: "update", level: "info", text: `Reattached on v${currentVersion()}`, taskId: id });
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
      // The first attempt is a start, even when the drain reserved it; retries keep running.
      const freshStart = i === 0 && !resuming;
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
        // The installed check uses the PATH the attempt will: strict work runs with the service's environment;
        // other work reads the login environment first.
        const servicePath = work?.options.delegationEnforcement === "strict";
        if (!servicePath) await terminalEnv(ctx.env, {cwd: ctx.home}).catch(() => undefined);
        const st = await deps.computeStatus({ ...ctx, now }, s, {includePlannerSignIn: task.interactionMode === "conversation", servicePath});
        startStatus = st;
        const blocked = readBlocked({ ...ctx, now });
        const broken = readBroken({ ...ctx, now });
        byId = Object.fromEntries(st.providers.map((p) => [p.id, { ...p, ...(blocked[p.id] ? {blockedReason:blocked[p.id].reason,blockedUntil:blocked[p.id].until} : {}), ...(broken[p.id] ? { brokenReason: broken[p.id].reason } : {}) }]));
        for (const p of Object.values(byId)) {
          const reason = executorExclusion({ ...ctx, now }, s, p.id);
          if (reason === "Blocked by you") p.blockedReason = reason;
          if (reason === "exhausted") { p.verdict = "EXHAUSTED"; p.eligibility = restrictEligibility(p.eligibility, "budget_exhausted"); }
        }
        // A conversation's requested executor is a preference the ranked list still validates and can
        // fall back from (the `req`/`full` handling below), exactly like a delegated task's requestedExecutor;
        // it is never a narrower candidate set, so an explicit request is excluded (and explained) by the
        // same decision as any other candidate rather than by a conversation-only restriction. Passing
        // `undefined` (not an explicit selection) here, same as a delegated task with no project policy,
        // keeps rankExecutors' own pacing-policy ordering in effect; conversationFallback below only
        // appends the requested executor afterward, when a routing rule left it out of the pool entirely.
        const ranking = rankExecutors(kind, s, byId, selection && {executors: selection.executors, order: "configured"},
          {includePlanner: !!work?.options.allowDelegation || task.interactionMode === "conversation"});
        if (task.interactionMode === "conversation" && !selection) conversationFallback(ranking, kind, s, byId, task.requestedExecutor);
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
        const routable = Array.isArray(f) ? rankedIds.filter(x => f.includes(x)) : rankedIds;
        // Managed work may retry a tried runner that still has an untried dispatch candidate
        // (another model or account), as on main; plain tasks never retry a tried executor.
        const untried=(runner:string)=>work?dispatchCandidates.some(c=>c.runner===runner&&!triedCandidates.has(c.id)):!tried.has(runner);
        routeAdmission=await authorizeRoute({...ctx,now:Date.now()/1000},id,routable.filter(untried),{
          strategy:current=>deps.loadStrategy(current),contextFingerprint:()=>JSON.stringify({tried:[...tried],triedCandidates:[...triedCandidates]}),
        });
        const authorized=routeAdmission.candidates;
        // Tried executors are never picked again, but stay visible so a conversation whose requested
        // executor hit its limit falls back to the next ranked one instead of queueing (#484).
        const allowed=[...authorized,...routable.filter(id=>tried.has(id)&&!authorized.includes(id))];
        for(const [candidate,plugin] of Object.entries(routeAdmission.excludedBy)) {
          policyExcluded.set(candidate,plugin);excluded.push({id:candidate,reason:`excluded by plugin ${plugin}`});
        }
        dispatchCandidates=dispatchCandidates.filter(candidate=>authorized.includes(candidate.runner)&&!policyExcluded.has(candidate.runner));
        if(req&&!tried.has(req)&&!authorized.includes(req)&&policyExcluded.has(req)) requestedUnavailable=`excluded by plugin ${policyExcluded.get(req)}`;
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
          const use = slotUse(listTasksWhere(ctx, { states: SLOT_STATES }).filter(t => t.id !== id));
          const full = new Set<string>();
          ranking.ranked = ranking.ranked.filter(candidate => {
            if (!allowed.includes(candidate.id)) return false;
            const guard = executorExclusion({ ...ctx, now: Date.now() / 1000 }, s, candidate.id);
            if (guard) { excluded.push({ id: candidate.id, reason: guard }); return false; }
            // The machine guard holds only a start, never a retry of a running task.
            const reason = slotBlock(s, candidate.id, use, {guard: freshStart});
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
          // An explicit interactive runner can never be certified, so refuse at once rather than wait or swap it.
          const refused = work && decision ? strictInteractiveRefusal(decision, req) : undefined;
          if (refused) {
            task = updateTask(ctx, id, t => {
              t.state = "failed"; t.result = {status: "failed", executor: null, model: null, files: "", report: `${refused}: ${STRICT_INTERACTIVE_REASON}`, backend: "direct"};
              delete t.queue; delete t.runnerPid; delete t.executor; delete t.attemptStartedAt;
            });
            return;
          }
          pick = requested && ids.includes(req!) ? req! : ids.find(e => work ? dispatchCandidates.some(c=>c.runner===e&&!triedCandidates.has(c.id)) : !tried.has(e));
          pickReason = ranking.ranked.find(e => e.id === pick)?.reason;
          if (work && pick && decision) {
            const c = dispatchCandidates.find(c=>c.runner===pick);
            if (!c || !reserveDispatch({...ctx,now},id,c,decision)) pick=undefined;
          }
          const machineHeld = freshStart && [...full].some(e => !tried.has(e) && !!localMachineGuard(s, e));
          if (work && !pick && !paused && !machineHeld) {
            const expired=work.options.expiresAt!==undefined&&work.options.expiresAt<=now;
            const exclusion=decision?.excluded.find(e=>e.id===task.requestedExecutor)
              ??decision?.excluded.find(e=>e.reason.includes("Native subagent control")&&e.reason!==STRICT_INTERACTIVE_REASON)
              ??decision?.excluded.find(e=>e.reason.includes("Native subagent control"))
              ??decision?.excluded[0];
            task=updateTask(ctx,id,t=>{
              routeAdmission!.revalidate();
              if(expired||decision?.recommendedAction==="fail"){t.state="failed";t.result={status:"failed",executor:null,model:null,files:"",report:expired?"Work expired in queue":"No dispatch candidate satisfies policy",backend:"direct"};delete t.queue;}
              else {t.state="queued";t.queue={reason:"waiting_retry",detail:exclusion?`${exclusion.id}: ${exclusion.reason}`:"Waiting for dispatch capacity or dependencies",since:initial.queue?.since??now,position:1,nextAt:now+30};}
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
              t.queue = {...capacity, reason: paused ? "paused" : capacity?.reason ?? "no_slot", since: initial.queue?.since ?? now, position: waiting.length + 1};
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
        if (task.queue || task.state === "failed") return task;
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
      attemptedExecutor = pick;
      if (resuming && !cfg) {
        return finish(ctx, id, { status: "failed", executor: pick, model: null, files: "", report: `cannot resume: executor ${pick} is no longer configured`, backend: "direct" });
      }
      attemptedModel = cfg.model ?? null;

      if (!resuming && stopped(ctx, id)) {
        return finish(ctx, id, { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" });
      }
      const onSpawn = (pid: number) => {
        const identity = processIdentity(pid);
        updateTask(ctx, id, (t) => { t.childPid = pid; if (identity) t.childIdentity = identity; else delete t.childIdentity; });
        if (stopped(ctx, id) && !resolveRunner(s, pick!)?.host) killTree(pid, "SIGTERM");
      };
      if (!resuming) {
        const selectedRunner = resolveRunner(s, pick);
        if (selectedRunner) await ensureRunnerIntegration(ctx, selectedRunner);
      }
      const backend = resuming || deps.runAttempt ? null : needsDirectBackend(task, work?.options.delegationEnforcement === "strict") ? directBackend : await selectBackend(ctx, s, undefined, pick);
      attemptedBackend = backend?.id ?? "direct";
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
        const refreshedById = Object.fromEntries(prepared.status.providers.map(p => [p.id, p]));
        const refreshedRanking = rankExecutors(kind, currentStrategy, refreshedById, selection && {executors: selection.executors, order: "configured"},
          {includePlanner: !!work?.options.allowDelegation || task.interactionMode === "conversation"});
        if (task.interactionMode === "conversation" && !selection) conversationFallback(refreshedRanking, kind, currentStrategy, refreshedById, task.requestedExecutor);
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
      if(work?.options.delegationEnforcement==="strict"&&!(resuming&&handedOver)){
        const checkedCtx={...ctx,now:Date.now()/1000};
        const checkedRepo=task.repo?.path??task.brief.repo;
        let reason=await enforcementExclusion(checkedCtx,s,pick,checkedRepo,task.interactionMode==="conversation");
        let evidence:ReturnType<typeof certificateEvidence>|undefined;
        if(!reason)try{evidence=certificateEvidence(checkedCtx,await resolveEnforcementTarget(checkedCtx,s,pick,checkedRepo));}
        catch(error){reason=error instanceof Error?error.message:"Native subagent control is unverified";}
        if(reason===STRICT_INTERACTIVE_REASON&&pick===task.requestedExecutor){
          releaseDispatch(ctx,id);
          updateTask(ctx,id,t=>{delete t.pendingAttempt;delete t.attemptStartedAt;delete t.executor;});
          return finish(ctx,id,{status:"failed",executor:pick,model:null,files:"",report:`${pick}: ${reason}`,backend:"direct"});
        }
        if(reason){
          releaseDispatch(ctx,id);
          task=updateTask(ctx,id,t=>{t.state="queued";t.queue={reason:"waiting_retry",detail:`Native subagent control unverified for ${pick}: ${reason}`,since:t.queue?.since??Date.now()/1000,position:1,nextAt:Date.now()/1000+30};delete t.runnerPid;delete t.executor;delete t.attemptStartedAt;delete t.run;});
          return task;
        }
        const attempt=task.attempts.length+1;
        updateWorkDecision(checkedCtx,id,attempt,{enforcement:evidence});
        appendWorkEvent(checkedCtx,id,"enforcement.checked",{attempt,runner:pick,state:"certified",certificate:evidence});
      }
      tried.add(pick);
      const selectedCandidate = dispatchCandidates.find(c=>c.runner===pick);
      if(selectedCandidate)triedCandidates.add(selectedCandidate.id);
      let executionCtx=ctx;
      if(work?.options.delegationEnforcement==="strict"){
        const markerDir=join(ctx.pacerHome,"guard-failures"),marker=join(markerDir,`${id}-${task.attempts.length+1}`);
        if(resuming&&handedOver){
          mkdirSync(markerDir,{recursive:true,mode:0o700});
          executionCtx={...executionCtx,env:{...executionCtx.env,PACER_ENFORCEMENT_MODE:"strict",PACER_GUARD_FAILURE_MARKER:marker}};
        } else {
          const token=issueEnforcementToken({...ctx,now:Date.now()/1000},id,task.attempts.length+1);
          mkdirSync(markerDir,{recursive:true,mode:0o700});
          rmSync(marker,{force:true});
          executionCtx={...executionCtx,env:{...executionCtx.env,PACER_ENFORCEMENT_MODE:"strict",PACER_ENFORCEMENT_TOKEN:token,PACER_GUARD_FAILURE_MARKER:marker}};
        }
      }
      if(work?.options.allowDelegation&&!(resuming&&handedOver)){const token=issueWorkGrant({...ctx,now:Date.now()/1000},id,task.attempts.length+1);executionCtx={...executionCtx,env:{...executionCtx.env,PACER_WORK_GRANT:token}};}

      let out: AttemptOutcome;
      try {
        out = resuming ? await resumeAttempt(executionCtx, cfg, task) : await (deps.runAttempt ?? backend!.runAttempt)(executionCtx, cfg, task, onSpawn);
      } catch (error) {
        if (!/ENOENT|EACCES|command not found/.test(String(error))) throw error;
        const code = /EACCES/.test(String(error)) ? 126 : 127;
        out = {
          backend: attemptedBackend, report: String(error),
          exec: { code, stdout: "", stderr: String(error), timedOut: false },
          attempt: { executor: pick, model: cfg.model, startedAt: task.attemptStartedAt!, endedAt: Date.now()/1000, exitCode: code, timedOut: false, limitHit: false, log: "" },
        };
      }
      const failureMarker=executionCtx.env.PACER_GUARD_FAILURE_MARKER;
      if(work?.options.delegationEnforcement==="strict"&&failureMarker&&existsSync(failureMarker)){
        rmSync(failureMarker,{force:true});
        const attempt=task.attempts.length+1,loss={at:Date.now()/1000,reason:"Native guard could not report its denial to the service"};
        const row=dispatchDatabase(ctx).query<{data:string},[string,number]>("SELECT data FROM work_decisions WHERE task_id=? AND attempt=?").get(id,attempt);
        const enforcement=row?(JSON.parse(row.data) as {enforcement?:Record<string,unknown>}).enforcement:undefined;
        updateWorkDecision(ctx,id,attempt,{enforcement:{...enforcement,loss}});
        appendWorkEvent({...ctx,now:loss.at},id,"enforcement.lost",{attempt,runner:pick,reason:loss.reason});
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
      if(work){releaseDispatch(ctx,id);revokeWorkGrants(ctx,id);revokeEnforcementTokens(ctx,id);}
      if(work)out.attempt.dispatchSettingsHash=dispatchSettingsHash(s,pick);
      out.attempt.routing = routing;
      out.attempt.usageAtStart = usageAtStart;
      const refreshAccounts = s.accounts[account] && usageRefreshCapability(s.accounts[account]) !== "unavailable" ? [account] : [];
      out.attempt.usageAtEnd = usage(await safe(() => deps.computeStatus({ ...ctx, now: Date.now() / 1000 }, s, {refreshAccounts}), undefined));
      attemptedBackend = out.backend ?? attemptedBackend;
      out.attempt.tokens = extractAttemptTokens({ executor: pick, log: attemptUsageText(ctx, id, task.attempts.length + 1, pick, out.attempt.log),
        exitCode: out.attempt.exitCode, timedOut: out.attempt.timedOut, takeover, now: out.attempt.endedAt });
      task = updateTask(ctx, id, (t) => {
        t.attempts.push(out.attempt);
        // Same transaction as the attempt; an index failure must not lose the attempt itself.
        try { recordAttemptUsage(ctx, t, t.attempts.length, out.attempt.tokens!, authAccount); } catch (error) { console.warn(`pacer: token usage index not updated for ${id}: ${error instanceof Error ? error.message : String(error)}`); }
        delete t.pendingAttempt;
        t.backend = attemptedBackend;
        delete t.childPid;
        delete t.childIdentity;
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
      // A conversation ending (or escalating with a question) now takes the same path as a
      // delegated task: a real diff, an optional acceptance check, and eligibility for
      // needs_input/review/retry, rather than a done/failed verdict with no verification.
      if (task.question && task.question.answer === undefined) {
        const v = out.partial ? {files:"(kept on host)"} : await deps.verifyRepo(out.worktree ?? task.brief.repo, undefined, ctx.env);
        return finish(ctx,id,{status:"needs_input", executor:pick, model:cfg.model, ...v, report:out.report, backend:attemptedBackend, ...(out.worktree ? {worktree:out.worktree} : {})});
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
        markExhausted({ ...ctx, now: out.attempt.endedAt }, resolveRunner(s, pick)?.account ?? pick, exhaustUntil(byId[pick], cfg, Date.now() / 1000, `${out.exec.stderr}\n${out.exec.stdout}\n${out.report}`), { scope: outcomeScope });
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
      const v: Verification = out.partial ? { files: "(kept on host)" } : await deps.verifyRepo(out.worktree ?? task.brief.repo, task.brief.acceptance, ctx.env, (task.brief.acceptanceTimeoutMin ?? 10) * 60_000, task.brief.pipefail);
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
