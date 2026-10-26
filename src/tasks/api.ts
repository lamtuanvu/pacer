import { prepareCreationAdmission } from "./creation-admission";
import { createHash } from "node:crypto";
import { withLock } from "../core/lock";
import { readTask as currentTask } from "./store";
import { buildModelInventory } from "../dispatch/inventory";
import { meetsRequirements } from "../dispatch/candidates";
import { authorizeWorkGrant, getWork } from "../dispatch/work";
import { MissingStrategyError } from "../config/strategy";
import { registerWork, workOptionsSchema, type WorkOptions } from "../dispatch/work";
import { beginWorkSync, describeWorkSync, finishWorkSync, validatePendingWorkSync, markLaunchStartedSync, finishUnlaunchedWorkSync } from "../update/desktop/admission";
import { requirePolicyIdentity } from "../core/project-policy";
import { readProjectStrategies } from "../config/project-strategies";
import { resolveProjectSelection } from "../engine/project-routing";
import { requireProjectExecutor } from "../core/project-policy";
import { registeredRepo } from "../core/repos";
import { CoreError } from "../core/errors";
import { shortTitle, taskTitle } from "../core/short-title";
import type { RepoRef } from "../api/read-model/types";
import { readPause } from "../core/pause";
import { clip, LIMITS } from "../link/envelope";
import { resolveRunner } from "../config/runner-id";
import { z } from "zod";
import { appendLabel } from "./labels";
import { executorExclusion } from "../executors/availability";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { KINDS, type Strategy, loadStrategy } from "../config/strategy";
import { killTree } from "../exec/process";
import { RemoteRunIO } from "../remote/run-io";
import { readRunLiveness } from "../supervisor/run";
import type { Ctx } from "../types";
import { taskDatabase, createTask, listTasksWhere, readTask, updateTask, withTaskLock } from "./store";
import { type Brief, TERMINAL_STATES, type TaskRecord, type WorktreeRequest } from "./types";

export const EXECUTOR_DELEGATE_ERROR = "PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.";
export function validBase(base: string): boolean {
  if (/^[0-9a-f]{7,40}$/i.test(base)) return true;
  // Reject branch shorthand so validation cannot expand caller-local state.
  if (!base || base.includes("\0") || base.startsWith("-") || base.includes("@{")) return false;
  return spawnSync("git", ["check-ref-format", "--branch", base], { stdio: "ignore" }).status === 0;
}
export const delegateSchema = {
  dispatch: z.unknown().optional(),
  title: z.string().trim().min(1).max(60).describe("Short task title (trimmed, 1–60 characters), stored separately from the full goal. Omitted titles are derived from the first goal clause with paths, URLs and backticked code removed and word-boundary truncation with an ellipsis. Snapshot tasks, task events, task.get, task.list, attention titles and activity text expose this title; older tasks derive it on read.").optional(),
  request_id: z.string().min(1).max(128).optional(),
  base: z.string().min(1).max(4096).refine(validBase, "base must be a branch name or a 7–40 hex SHA").optional(),
  source: z.enum(["planner", "ui", "cli"]).optional(),
  goal: z.string().min(1), repo: z.string().min(1),
  scope: z.string().optional(), acceptance: z.string().optional(), constraints: z.string().optional(), context: z.string().optional(),
  kind: z.enum(KINDS).optional(), executor: z.string().optional(),
  worktree_base: z.enum(["default", "head"]).optional(),
  worktree: z.enum(["current", "new", "auto"]).optional(), worktree_reason: z.string().max(200).optional(),
  timeout_min: z.number().min(1).max(240).optional(),
};
export function parseDelegateBrief(raw: unknown, defaultRepo: string): DelegateInput {
  const parsed=z.object(delegateSchema).safeParse({repo:defaultRepo,...(raw as object)});
  if(!parsed.success)throw new DelegateError(parsed.error.issues.map(i=>i.path[0]==="worktree"?"worktree must be one of current, new, auto":i.path[0]==="worktree_reason"?"worktree_reason must be a string of at most 200 characters":`${i.path.join(".")}: ${i.message}`).join("; "));
  const a=parsed.data;
  return { brief: { goal:a.goal, repo:a.repo, scope:a.scope, acceptance:a.acceptance, constraints:a.constraints, context:a.context, base:a.base, worktreeBase:a.worktree_base },
    dispatch:a.dispatch?workOptionsSchema.parse(a.dispatch):undefined, title:a.title, requestId:a.request_id, source:a.source,
    kind:a.kind, executor:a.executor, timeoutMin:a.timeout_min, worktree:a.worktree, worktree_reason:a.worktree_reason };
}
export function summarizeTask(t: TaskRecord): Record<string, unknown> {
  return { ...(t.archived ? {archived:true, archive_path:t.archivePath} : {}), task_id:t.id, title:taskTitle(t), goal:clip(t.brief.goal, LIMITS.goal), state:t.state, kind:t.kind, requested_executor:t.requestedExecutor, ...(t.executorFallback ? {executor_fallback:t.executorFallback} : {}), placement:t.placement??null, queue:t.queue??null,
    attempts:t.attempts.map(a=>({executor:a.executor,exit_code:a.exitCode,limit_hit:a.limitHit,timed_out:a.timedOut,log:a.log})),
    ...(t.question ? {question:t.question} : {}),
    ...(t.reviewRequest ? {reviewRequest:t.reviewRequest} : {}),
    result:t.result??null, review:t.review??null, resolved:t.resolved??null };
}
export function taskReview(ctx: Ctx, id: string, accepted: boolean, kind?: string, note?: string): {recorded:true} {
  const t=taskStatus(ctx,id); if(!t)throw new Error(`unknown task ${id}`);
  if(kind && !(KINDS as readonly string[]).includes(kind))throw new Error(`unknown kind "${kind}"`);
  appendLabel(ctx,{type:"task_review",task_id:id,accepted,kind:kind??t.kind,note:note??null,executor:t.result?.executor??null});
  updateTask(ctx,id,x=>{x.review={accepted,kind:kind??t.kind,note:note??null,at:ctx.now};x.resolved="reviewed";});
  return {recorded:true};
}
export function taskDismiss(ctx: Ctx, id: string): TaskRecord | null {
  return readTask(ctx,id) ? updateTask(ctx,id,t=>{t.dismissed=true;}) : null;
}

export const DEFAULT_TIMEOUT_MIN = 30;

export class DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateError";
  }
}

export interface DelegateInput { /** Trusted operation lifetime, never parsed from client/plugin input. */ admissionSignal?:AbortSignal; admissionDeadline?:number; admissionTaskLock?:string; admissionPaths?:readonly string[]; admissionPrepare?:()=>Promise<void>; admissionValidate?:(candidate:Readonly<DelegateInput>)=>void; /** Trusted commit discipline; never parsed from client/plugin input. */ commitWith?: (commit:()=>TaskRecord)=>TaskRecord; admissionContext?:()=>string; dispatch?: WorkOptions; workParent?: string; workGrant?: string; workRequest?: {scope:string;key:string;fingerprint:string}; /** Internal pre-admitted launch, never parsed from API input. */ admissionLease?: string; title?: string; requestId?: string; source?: TaskRecord["source"]; repoRef?: RepoRef; client?: string; repoValidated?: boolean; reuseWorktree?: string; baseBranch?: string; baseSha?: string; brief: Brief; kind?: string | null; executor?: string | null; timeoutMin?: number; retryOf?: string; force?: boolean; worktree?: WorktreeRequest; worktree_reason?: string }
export type SpawnRunner = (ctx: Ctx, taskId: string) => number | undefined;

/** How to re-invoke this pacer: `bun src/cli.ts` in development, the compiled binary otherwise. */
export function selfCommand(argv: string[] = process.argv, execPath: string = process.execPath): string[] {
  const script = argv[1] ?? "";
  return /\.(ts|js|mjs)$/.test(script) ? [execPath, script] : [execPath];
}

const spawnRunnerProcess: SpawnRunner = (ctx, taskId) => {
  const [cmd, ...pre] = selfCommand();
  const child = spawn(cmd, [...pre, "_run", taskId], {
    detached: true,
    stdio: "ignore",
    env: { ...ctx.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome },
  });
  child.unref();
  return child.pid;
};

/** Persist admission before invoking even an injected launcher. Never clear an
 * uncertain launch just because its parent returned or spawn threw. */
export function launchTaskRunner(ctx: Ctx, taskId: string, spawn: SpawnRunner, admitted?: string): number | undefined {
  const inherited = ctx.env.PACER_ADMISSION_TASK === taskId ? ctx.env.PACER_ADMISSION_LEASE : undefined;
  const lease = admitted ?? inherited ?? beginWorkSync(ctx, { kind: "task", id: taskId, label: `Task ${taskId}` });
  validatePendingWorkSync(ctx, lease);
  describeWorkSync(ctx, lease, { kind: "task", id: taskId, label: `Task ${taskId}` });
  markLaunchStartedSync(ctx, lease);
  const {operation:_requestLifetime,...launchCtx}=ctx;
  return spawn({ ...launchCtx, env: { ...ctx.env, PACER_ADMISSION_LEASE: lease, PACER_ADMISSION_TASK: taskId } }, taskId);
}
export const spawnRunner: SpawnRunner = (ctx, taskId) => launchTaskRunner(ctx, taskId, spawnRunnerProcess);

export function validateInput(s: Strategy, input: DelegateInput): string[] {
  const p: string[] = [];
  const b = input.brief;
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 60)) p.push("title must be 1–60 characters after trimming");
  if (!b.goal?.trim()) p.push("goal is required");
  if (!b.repo || !isAbsolute(b.repo)) p.push("repo must be an absolute path");
  // Serve validates the folder with a bounded async stat first; never stat a repo on its main thread.
  else if (!input.repoValidated && (!existsSync(b.repo) || !statSync(b.repo).isDirectory())) p.push(`repo does not exist: ${b.repo}`);
  if (b.base !== undefined && !validBase(b.base)) p.push("base must be a branch name or a 7–40 hex SHA");
  if (input.requestId !== undefined && (!input.requestId.length || input.requestId.length > 128)) p.push("request_id must be 1–128 characters");
  if (input.source !== undefined && !["planner", "ui", "cli", "onboarding"].includes(input.source)) p.push("invalid source");
  if (input.kind && !(KINDS as readonly string[]).includes(input.kind)) {
    p.push(`unknown kind "${input.kind}" (allowed: ${KINDS.join(", ")})`);
  }
  const runner = input.executor ? resolveRunner(s, input.executor) : null;
  if (input.executor && !runner) {
    p.push(`unknown executor "${input.executor}" (configured: ${Object.keys(s.providers).join(", ")})`);
  } else if (input.executor && runner?.agent === s.planner.agent && runner.account === s.planner.account && !input.dispatch?.allowDelegation) {
    p.push(`"${input.executor}" is the planner; pick an executor`);
  }
  if (input.timeoutMin !== undefined && !(input.timeoutMin >= 1 && input.timeoutMin <= 240)) {
    p.push("timeout_min must be between 1 and 240");
  }
  if(b.worktreeBase !== undefined && !["default", "head"].includes(b.worktreeBase))p.push("worktree_base must be default or head");
  if(input.worktree!==undefined && !["current","new","auto"].includes(input.worktree))p.push("worktree must be one of current, new, auto");
  if(input.worktree_reason!==undefined && (typeof input.worktree_reason!=="string" || input.worktree_reason.length>200))p.push("worktree_reason must be a string of at most 200 characters");
  return p;
}

const admissionClocks = new WeakMap<Ctx,number>();
/** Preserve the request clock while accounting for time spent awaiting admission. */
export function admissionCtx(ctx:Ctx):Ctx {
  let started=admissionClocks.get(ctx);
  if(started===undefined) {started=performance.now();admissionClocks.set(ctx,started);}
  return {...ctx,now:ctx.now+(performance.now()-started)/1000};
}

/** Authorize before entering a caller's final synchronous task transaction. */
export async function prepareDelegate(
  ctx: Ctx, original: DelegateInput, spawnFn: SpawnRunner = spawnRunner, supplied?: Strategy,
  contextFingerprint: () => string = () => "",
  validateAmend: (candidate: Readonly<DelegateInput>) => boolean = () => true,
) {
  const fresh=()=>admissionCtx(ctx);
  const {commitWith,admissionContext,admissionSignal,admissionDeadline,admissionTaskLock,admissionPaths,admissionPrepare,admissionValidate,...cloneable}=original;
  const input=structuredClone(cloneable);
  const strategy=()=>{
    try {return loadStrategy(fresh());}
    catch(error){if(supplied&&error instanceof MissingStrategyError)return supplied;throw error;}
  };
  const initial=supplied??strategy();
  const basicProblems=validateInput(initial,{...input,repoValidated:true});
  if(basicProblems.length)throw new DelegateError(basicProblems.join("; "));
  input.repoValidated=true;
  if(input.executor)input.executor=resolveRunner(initial,input.executor)?.id??input.executor;
  const repo=input.repoRef??registeredRepo(ctx,input.brief.repo);
  const validate=(candidate:DelegateInput,current:Strategy)=>{
    const problems=validateInput(current,candidate);
    if(candidate.executor){
      const runner=resolveRunner(current,candidate.executor);
      if(runner?.enabled===false)problems.push(`${candidate.executor}: disabled`);
      if(candidate.dispatch&&!buildModelInventory(current,[],fresh().now).some(model=>model.runner===candidate.executor&&meetsRequirements(model,candidate.dispatch!.requirements)&&(!candidate.dispatch!.model||model.binding.kind==="exact"&&model.binding.id===candidate.dispatch!.model)))problems.push(`${candidate.executor}: incompatible managed model policy`);
      const reason=executorExclusion(fresh(),current,candidate.executor);if(reason)problems.push(`${candidate.executor}: ${reason}`);
    }
    if(problems.length)throw new DelegateError(problems.join("; "));
    const projects=readProjectStrategies(fresh());
    if(!repo&&Object.values(projects.projects).some(p=>p.executors))throw new CoreError("invalid_input","Resolve the repository before delegating with project policies");
    if(repo)requirePolicyIdentity(fresh(),repo);
    requireProjectExecutor(repo?resolveProjectSelection(current,repo.key,projects.projects):undefined,candidate.executor);
    if(candidate.workGrant)authorizeWorkGrant(fresh(),candidate.workGrant);
    if(candidate.admissionLease)validatePendingWorkSync(fresh(),candidate.admissionLease);
    admissionValidate?.(candidate);
  };
  const policyKind=input.dispatch?.kind??input.kind??null;
  const map=(next:{kind:string|null;requestedExecutor:string|null;placement:WorktreeRequest}):DelegateInput=>{
    const changed=next.kind!==policyKind;
    return {...input,kind:changed?next.kind:input.kind,executor:next.requestedExecutor,worktree:next.placement,
      ...(input.dispatch&&changed?{dispatch:{...input.dispatch,kind:next.kind??undefined}}:{})};
  };
  const capture=()=>{
    const current=strategy();
    return JSON.stringify({strategy:current,projects:readProjectStrategies(fresh()),repo,registered:registeredRepo(fresh(),input.brief.repo),
      parent:input.workParent?currentTask(fresh(),input.workParent):null,work:input.workParent?getWork(fresh(),input.workParent):null,
      root:input.workParent?getWork(fresh(),getWork(fresh(),input.workParent)!.rootId):null,
      active:input.workParent?listTasksWhere(fresh(),{states:["running"]}).map(t=>[t.id,t.rev]):null,
      candidates:Object.keys(current.runners).map(id=>[id,executorExclusion(fresh(),current,id)]),context:[contextFingerprint(),admissionContext?.()]});
  };
  const admission=await prepareCreationAdmission(fresh(),{goal:input.brief.goal,repo:input.brief.repo,kind:policyKind,requestedExecutor:input.executor??null,placement:input.worktree??"auto"},{
    contextFingerprint:capture,taskLock:admissionTaskLock,validateArtifacts:admissionPrepare,signal:admissionSignal,deadline:admissionDeadline,
    additionalDirectories:[...(input.reuseWorktree?[input.reuseWorktree]:[]),...(admissionPaths??[])],
    eligibleRunnerIds:Object.keys(initial.runners),allowedPlacements:input.workParent||input.reuseWorktree?[input.worktree??"auto"]:["auto","current","new"],
    validateCurrent:next=>validate(map(next),strategy()),
    validateAmend:next=>{try{const candidate=map(next);validate(candidate,strategy());return validateAmend(candidate);}catch{return false;}},
  });
  const candidate=map(admission.input);
  const synchronous=(effect:Function)=>{
    if(effect.constructor.name==="AsyncFunction"||commitWith?.constructor.name==="AsyncFunction")throw new CoreError("invalid_input","Admission effect must be synchronous");
  };
  return {
    input:structuredClone(candidate),policies:admission.policies,
    consume<T>(effect:(permit:{input:Readonly<DelegateInput>;revalidate:()=>void})=>T):Promise<T>{
      synchronous(effect);return admission.consume(({input,revalidate})=>effect({input:structuredClone(map(input)),revalidate}));
    },
    commit:()=>{
      synchronous(()=>{});
      return admission.consume(({revalidate})=>{
        let committed=false;
        const commit=()=>{if(committed)throw new CoreError("conflict","Delegation commit was already consumed");revalidate();committed=true;return commitDelegate(fresh(),candidate,spawnFn,strategy());};
        return commitWith?commitWith(commit):commit();
      });
    },
  };
}

/** Public lower API is an admitted async gateway; the raw constructor is private. */
export async function delegate(
  ctx: Ctx, input: DelegateInput, spawnFn: SpawnRunner = spawnRunner, s?: Strategy,
): Promise<TaskRecord> {
  admissionCtx(ctx);
  const lease=input.admissionLease??beginWorkSync(ctx,{kind:"launch",id:"delegate",label:"Delegating task"});
  const run=async()=>{
    const currentNow=admissionCtx(ctx).now;
    if(input.requestId) {
      const prior=listTasksWhere(ctx,{updatedSince:currentNow-600}).find(t=>t.requestId===input.requestId&&currentNow-t.createdAt>=0&&currentNow-t.createdAt<=600);
      if(prior&&(prior.brief.goal!==input.brief.goal||prior.brief.repo!==input.brief.repo)) throw new CoreError("conflict","request_id was already used for a different brief");
      if(prior) return prior;
    }
    const admission=await prepareDelegate(ctx,{...input,admissionLease:lease},spawnFn,s);
    return admission.commit();
  };
  try {return await (input.requestId?withLock(ctx,`delegate-request-${createHash("sha256").update(input.requestId).digest("hex")}`,run):run());}
  finally {finishUnlaunchedWorkSync(ctx,lease);}
}

function commitDelegate(
  ctx: Ctx, input: DelegateInput, spawnFn: SpawnRunner = spawnRunner, s: Strategy = loadStrategy(ctx),
): TaskRecord {
  const lease = input.admissionLease ?? beginWorkSync(ctx, { kind: "launch", id: "delegate", label: "Delegating task" });
  let handed = false;
  try {
  const paused = readPause(ctx);
  if (input.executor) input = {...input, executor: resolveRunner(s, input.executor)?.id ?? input.executor};
  const problems = validateInput(s, input);
  if (input.executor) {
    const reason = executorExclusion(ctx, s, input.executor);
    if (reason) problems.push(`${input.executor}: ${reason}`);
  }
  if (problems.length) throw new DelegateError(problems.join("; "));
  const policies = readProjectStrategies(ctx);
  const repo = input.repoRef ?? registeredRepo(ctx, input.brief.repo);
  if (!repo && Object.values(policies.projects).some(p => p.executors)) throw new CoreError("invalid_input", "Resolve the repository before delegating with project policies");
  if (repo) requirePolicyIdentity(ctx, repo);
  requireProjectExecutor(repo ? resolveProjectSelection(s, repo.key, policies.projects) : undefined, input.executor);
  const task = createTask(ctx, {
    title: input.title?.trim() ?? shortTitle(input.brief.goal),
    brief: input.brief,
    kind: input.kind ?? null,
    requestedExecutor: input.executor ?? null,
    timeoutS: Math.round((input.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60),
  }, created => {if(input.dispatch || s.dispatch)registerWork(ctx,created.id,input.dispatch??{},input.workParent,input.workGrant);if(input.workRequest){const db=taskDatabase(ctx);db.query("INSERT INTO work_requests(scope,key,fingerprint,task_id) VALUES(?,?,?,?)").run(input.workRequest.scope,input.workRequest.key,input.workRequest.fingerprint,created.id);}});
  updateTask(ctx,task.id,t=>{t.source=input.source ?? "planner"; if(input.requestId)t.requestId=input.requestId; t.placement={requested:input.worktree??"auto",...(input.worktree_reason!==undefined?{reason:input.worktree_reason}:{})};});
  if(input.repoRef || input.client)updateTask(ctx,task.id,t=>{if(input.repoRef)t.repo=input.repoRef;if(input.client)t.client=input.client;});
  if(input.force)updateTask(ctx,task.id,t=>{t.force=true;});
  if (input.retryOf) updateTask(ctx, task.id, t => { t.retryOf = input.retryOf; });
  if (input.reuseWorktree) updateTask(ctx, task.id, t => {
    t.worktree = input.reuseWorktree; t.baseBranch = input.baseBranch; t.baseSha = input.baseSha;
  });
  if (paused) updateTask(ctx, task.id, t => {
    t.queue = {reason: "paused", since: ctx.now, position: 1 + listTasksWhere(ctx, { states: ["queued"] }).filter(x => x.id !== t.id && x.queue).length};
  });
  else { handed = true; launchTaskRunner(ctx, task.id, spawnFn, lease); }
  return readTask(ctx,task.id)!;
  } finally { if (!handed) finishWorkSync(ctx, lease); }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isTerminal = (t: TaskRecord) => TERMINAL_STATES.includes(t.state);

/** Read task state without supervising or spawning runners. */
export function taskStatus(ctx: Ctx, id: string): TaskRecord | null {
  return readTask(ctx, id);
}

/** Selected records are already current; reads never supervise them. */
export function taskRecordStatus(_ctx: Ctx, t: TaskRecord): TaskRecord {
  return t;
}

/** Explicit supervision shared by the service and CLI fallback paths. */
export async function superviseTask(ctx: Ctx, id: string, spawn: SpawnRunner = spawnRunner): Promise<TaskRecord | null> {
  const t = readTask(ctx, id);
  return t ? superviseTaskRecord(ctx, t, spawn) : null;
}

async function superviseTaskRecord(ctx: Ctx, t: TaskRecord, spawn: SpawnRunner, stopped: () => boolean = () => false): Promise<TaskRecord> {
  if (!["queued", "running"].includes(t.state)) return t;
  const id = t.id;
  const run = t.run, current = run && run.attempt > t.attempts.length;
  const deadRun = t.state === "running" && current && !alive(t.runnerPid);
  const r = deadRun && !run.host ? await readRunLiveness(run.dir) : null;
  if (stopped()) return t;
  return withTaskLock(ctx, id, () => {
    // Repository IO yields; an independent runner may have settled meanwhile.
    const latest = readTask(ctx, id);
    if (!latest || latest.rev !== t.rev) return latest ?? t;
    if (deadRun && (run.host || (r && (r.alive || r.exit !== null)))) {
      if (!t.resumeSpawnedAt || ctx.now - t.resumeSpawnedAt >= 60) {
        let lease: string;
        try { lease = beginWorkSync(ctx, { kind: "task", id, label: `Recovering task ${id}` }); }
        catch { return t; } // Keep recovery intent while maintenance or coordination is unavailable.
        updateTask(ctx, id, x => { x.resumeSpawnedAt = ctx.now; });
        try { launchTaskRunner(ctx, id, spawn, lease); } catch { /* ambiguous launch remains a blocker */ }
      }
      return readTask(ctx, id)!;
    }
    const neverStarted = !t.queue && ["queued", "running"].includes(t.state) && !t.attemptStartedAt && !t.attempts.length && !alive(t.runnerPid) && ctx.now - t.createdAt > 600;
    if (neverStarted || (t.state === "running" && (t.attempts.length > 0 || t.attemptStartedAt !== undefined || ctx.now - t.createdAt > 600) && !alive(t.runnerPid))) {
      return updateTask(ctx, id, (x) => {
        if (TERMINAL_STATES.includes(x.state)) return;
        x.state = "failed";
        x.result = {
          status: "failed", executor: x.attempts.at(-1)?.executor ?? null, model: null, files: "",
          report: neverStarted ? "the pacer runner never started" : "the pacer runner exited unexpectedly", backend: "direct",
        };
      });
    }
    return t;
  });
}

/** Query only active tasks and yield between records so HTTP can keep serving. */
export async function superviseTasks(ctx: Ctx, spawn: SpawnRunner = spawnRunner, stopped: () => boolean = () => false): Promise<void> {
  for (const task of listTasksWhere(ctx, { states: ["queued", "running"] })) {
    await Bun.sleep(0);
    if (stopped()) return;
    await superviseTaskRecord(ctx, task, spawn, stopped);
  }
}

export async function taskWait(ctx: Ctx, id: string, timeoutS: number, pollMs = 1000): Promise<TaskRecord | null> {
  const started = Date.now(), deadline = started + timeoutS * 1000;
  for (;;) {
    const currentCtx = {...ctx, now: ctx.now + (Date.now() - started) / 1000};
    await (await import("./drain")).drainQueue(currentCtx);
    const t = await superviseTask(currentCtx, id);
    if (!t || isTerminal(t) || Date.now() >= deadline) return t;
    await Bun.sleep(pollMs);
  }
}

/** Mark a task stopped and kill its executor; a live runner then finalizes it as stopped. */
export function taskStop(ctx: Ctx, id: string): TaskRecord | null {
  const t = readTask(ctx, id);
  if (!t) return null;
  if (t.state === "needs_input") return updateTask(ctx, id, x => {
    x.state = "stopped";
    if (x.result) x.result.status = "stopped";
  });
  if (isTerminal(t)) return t;
  const runnerAlive = t.state === "running" && alive(t.runnerPid);
  const updated = updateTask(ctx, id, (x) => {
    if (TERMINAL_STATES.includes(x.state)) return;
    x.state = "stopped";
    if (!runnerAlive) {
      x.result = { status: "stopped", executor: null, model: null, files: "", report: "stopped before an executor ran", backend: "direct" };
    }
  });
  if (t.run?.host) {
    try {
      const host = loadStrategy(ctx).hosts[t.run.host];
      if (host && t.run.remoteDir) void new RemoteRunIO(ctx, host, t.run.remoteDir, t.run.dir)
        .stop({ graceMs: 5000, sleep: ms => Bun.sleep(ms) }).catch(() => { /* a live supervisor retries the stop */ });
    } catch { /* retain the stop flag for the supervisor when config is unavailable */ }
  } else if (t.childPid) killTree(t.childPid, "SIGTERM");
  return updated;
}
