import { beginWorkSync, bindOrcaWorkSync, finishOrcaWorkSync, finishWorkSync } from "../../update/desktop/admission";
import { resolveWorktreeBase } from "../../supervisor/worktree";
import { pidAlive } from "../../link/store";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { shellCommand } from "../../install/fsx";
import { claudeConfigFile, type McpChoices, projectMcpChoices } from "../claude-trust";
import { launchArgvFor, providerEnv } from "../launch";
import { recordDefaultFolder } from "../account-folder";
import { profileKeys, terminalEnv, type TerminalEnv } from "../login-env";
import { prepareInteractive } from "../../session/reports";
import { readJson, writeJsonAtomic } from "../../fsutil";
import { type ExecutionCfg, validateExecution } from "../../config/execution";
import { type ProviderCfg, loadStrategy } from "../../config/strategy";
import { readTask, tasksDir, listTasksWhere, updateTask } from "../../tasks/store";
import { type LiveWorker, resolvePlacement, type ResolvedPlacement, type TaskRecord } from "../../tasks/types";
import { taskActivity } from "../../core/tasks";
import type { Ctx } from "../../types";
import type { Backend } from "../backend";
import { type AttemptOutcome, mcpNotApproved, REPORT_CHARS, runAttempt as directAttempt, runDir, tail } from "../direct";
import { detectLimit } from "../limits";
import { brokenReason, repoFingerprint } from "../broken";
import type { ExecResult } from "../process";
import { buildPrompt } from "../prompt";
import { orcaAgentFor } from "./agents";
import { OrcaClient, type Placement, type TerminalRow, type WorkerStartResult, type WorktreeRow, isReady } from "./client";
import { closeCreatedTerminal, discardCreatedWorktree, lookupWorker, type OwnedWorktree, recordStrayRisk, recordUnclosed, type WorkerLookup, worktreeTerminals } from "./cleanup";
import { ensureCoordinator, ensureGroupWorktree, ensureRepo, gitInfo, realpathSafe } from "./setup";
import { loadOrcaState, updateOrcaState, withLock } from "./state";
import { SETTLED_STATES, type WaitResult, waitForWorker } from "./wait";

export interface OrcaBackendDeps {
  loadExecution: (ctx: Ctx) => ExecutionCfg;
  admission: { begin: typeof beginWorkSync; bind: typeof bindOrcaWorkSync; finishOrca: typeof finishOrcaWorkSync; finish: typeof finishWorkSync };
  direct: Backend["runAttempt"];
  /** The user's login-shell environment, read for the default account's folder only. */
  terminalEnv: (ctx: Ctx) => Promise<TerminalEnv>;
  sliceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULTS: OrcaBackendDeps = {
  loadExecution: (ctx) => validateExecution(loadStrategy(ctx).execution),
  admission: { begin: beginWorkSync, bind: bindOrcaWorkSync, finishOrca: finishOrcaWorkSync, finish: finishWorkSync },
  direct: directAttempt,
  terminalEnv: (ctx) => terminalEnv(ctx.env, {cwd: ctx.home}),
  sliceMs: 30_000,
  now: () => Date.now(),
  sleep: (ms) => Bun.sleep(ms),
};

interface Ready {
  ok: true;
  agent: string;
  model: string | null;
  coordinator: string;
  run: string;
  placement: Placement;
  top: string;
  main: string;
  base: string;
  sub: string;
  notes: string[];
  resolved: ResolvedPlacement;
}
type Prepared = { ok: false; reason: string; refuse?:boolean } | Ready;
interface Mapped { code: number; timedOut: boolean; settled: boolean; summary: string; tail?: string }

async function prepare(ctx: Ctx, c: OrcaClient, cfg: ProviderCfg, task: TaskRecord, ex: ExecutionCfg): Promise<Prepared> {
  const preliminary=resolvePlacement(task,ex.worktree,false);
  const pick = orcaAgentFor(cfg, task.retryOf && task.worktree ? "current" : preliminary.mode==="current"?"current":ex.worktree==="current"?"new-child":ex.worktree);
  if ("skip" in pick) return { ok: false, reason: pick.skip };
  if (!isReady(await c.status())) return { ok: false, reason: "the Orca runtime is not ready (orca status)" };
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return { ok: false, reason: git.error };
  const active=listTasksWhere(ctx, { states: ["running"] }).some(t=>{
    if(t.id===task.id||t.state!=="running"||!t.runnerPid||!pidAlive(t.runnerPid))return false;
    const path=realpathSafe(t.worktree??t.result?.worktree??t.brief.repo), top=realpathSafe(git.top);
    return path===top||path.startsWith(top+"/");
  });
  if(active&&task.placement?.requested==="current")return {ok:false,reason:"another pacer task is running in the current worktree; requested current placement refused",refuse:true};
  const resolved=resolvePlacement(task,ex.worktree,active,git.dirty);
  if(resolved.mode==="current"&&resolved.why==="strategy default"&&git.dirty)return {ok:false,reason:"current worktree has uncommitted changes",refuse:true};
  const mapped=orcaAgentFor(cfg,task.retryOf && task.worktree ? "current" : resolved.mode==="current"?"current":"new-child");
  if("skip" in mapped)return {ok:false,reason:mapped.skip};
  const resolvedBase = resolved.mode === "current" || (task.retryOf && task.worktree)
    ? { base: task.baseBranch ?? git.branch, sha: task.baseSha }
    : await resolveWorktreeBase(ctx, git.top, task.brief, ex.baseBranch, ex.worktree === "child-of-current" && task.placement?.requested !== "new");
  if ("error" in resolvedBase) return { ok: false, reason: resolvedBase.error, refuse: true };
  const base = resolvedBase.base;
  if (resolvedBase.sha) updateTask(ctx, task.id, t => { t.baseSha = resolvedBase.sha; });
  const repoId = await ensureRepo(c, git.top, {main:git.main,linked:git.linked,registerRepos:ex.registerRepos});
  if (typeof repoId !== "string") return { ok: false, reason: repoId.error };
  const coord = await ensureCoordinator(ctx, c, git.top);
  if ("error" in coord) return { ok: false, reason: coord.error };
  const notes: string[] = [];
  if (resolved.mode !== "current" && git.dirty) {
    notes.push(`note: ${git.top} has uncommitted changes; the worker's new worktree starts from ${base} without them`);
  }
  // New-child worktree names pacer-<taskId>-<providerId> also identify executor hook sessions.
  // A --group lane is still a new-child worktree, nested under the group's shared parent worktree.
  let parentWorktree: string | undefined;
  if (!(task.retryOf && task.worktree) && resolved.mode !== "current" && task.group) {
    const group = await ensureGroupWorktree(ctx, c, repoId, task.group, resolvedBase.sha ?? base);
    if ("error" in group) return { ok: false, reason: group.error };
    parentWorktree = group.selector;
  }
  const placement: Placement = task.retryOf && task.worktree
    ? { kind: "existing", selector: `path:${task.worktree}` }
    : resolved.mode !== "current"
    ? { kind: "new-child", repoId, baseBranch: resolvedBase.sha ?? base, name: `pacer-${task.id}-${cfg.id}`, ...(parentWorktree ? { parentWorktree } : {}) }
    : { kind: "existing", selector: `path:${git.top}` };
  return {
    ok: true, agent: mapped.agent, model: mapped.model, coordinator: coord.coordinator, run: coord.run,
    placement, top: git.top, main: git.main, base, sub: git.sub, notes, resolved,
  };
}

function workerSpec(task: TaskRecord, p: Ready): string {
  const where = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
    : `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}` +
      `${p.placement.parentWorktree && task.group ? `, grouped under ${task.group}` : ""}` +
      `${p.sub ? `. Work in its ${p.sub}/ subdirectory` : ""}. Do not edit ${p.top} itself.`;
  const prompt = buildPrompt({ ...task.brief, repo: where }, task.id);
  return prompt;
}

function mapWait(w: WaitResult): Mapped {
  switch (w.kind) {
    case "done":
      return {
        code: w.outcome === "succeeded" ? 0 : 1, timedOut: false, settled: true,
        summary: [w.subject, w.body].filter((x) => x.trim()).join("\n\n") || `worker_done: ${w.outcome}`,
      };
    case "settled":
      return {
        code: w.state === "succeeded" ? 0 : 1, timedOut: false, settled: !w.needsStop, tail: w.tail,
        summary: `orca worker ${w.state} without a worker_done report${w.error ? ` (${w.error})` : ""}`,
      };
    case "timeout":
      return { code: 1, timedOut: true, settled: false, summary: "orca worker timed out at the task timeout; stopped it" };
    case "stopped":
      return { code: 1, timedOut: false, settled: false, summary: "stopped by the planner; stopped the orca worker" };
  }
}

async function fallback(
  deps: OrcaBackendDeps, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn: ((pid: number) => void) | undefined, reason: string, lines: string[] = [],
): Promise<AttemptOutcome> {
  const out = await deps.direct(ctx, cfg, task, onSpawn);
  if (out.attempt.log) appendFileSync(out.attempt.log, [...lines, `direct backend: Orca fallback (${reason.replace(/\s+/g, " ").trim()})`].join("\n") + "\n");
  try {
    await withLock(ctx,"fallback",async()=>{
      const dir=join(ctx.pacerHome,"orca"), path=join(dir,"fallback.json");
      const prior=readJson<{at:number}>(path);
      if(prior && ctx.now-prior.at<3600)return;
      mkdirSync(dir,{recursive:true});
      appendFileSync(join(dir,"fallback.log"),`${new Date(ctx.now*1000).toISOString()} orca backend not used: ${reason.replace(/\s+/g," ").trim()}\n`);
      writeJsonAtomic(path,{at:ctx.now,reason});
    });
  }catch { /* Diagnostics must not prevent direct execution. */ }
  return { ...out, backend: "direct" };
}

/** Release or stop the dispatch; the caller closes the terminal. */
async function settle(c: OrcaClient, dispatchId: string, settled: boolean, log: (l: string) => void, receipt: (reply: Awaited<ReturnType<OrcaClient["workerStop"]>>) => void): Promise<void> {
  let stop = !settled;
  if (settled) {
    const rel = await c.workerRelease(dispatchId);
    receipt(rel);
    log(`worker-release: ${rel.ok ? (rel.result.state ?? "ok") : rel.error.code}`);
    if (!rel.ok && rel.error.code === "dispatch_inactive") stop = true;
  }
  if (stop) {
    const st = await c.workerStop(dispatchId);
    receipt(st);
    log(`worker-stop: ${st.ok ? (st.result.state ?? "ok") : st.error.code}`);
  }
}

function waitLine(dispatchId: string, w: WaitResult): string {
  switch (w.kind) {
    case "done": return `worker_done ${dispatchId}: ${w.outcome}`;
    case "settled": return `worker ${dispatchId} settled: ${w.state}${w.error ? ` (${w.error})` : ""}`;
    case "timeout": return `worker ${dispatchId}: timed out`;
    case "stopped": return `worker ${dispatchId}: stopped by the planner`;
  }
}

/** The worktree Orca returned must be the one pacer asked for (new-child name under the repo, or the existing path). */
function checkedWorktree(p: Ready, w: WorktreeRow | undefined): { id: string; path: string } {
  const id = w?.id;
  if (!id) throw Error("orca worktree returned no id");
  const sep = id.indexOf("::"), path = sep > 0 ? id.slice(sep + 2) : "";
  const mismatch = (why: string) => Error(`orca worktree ${id} does not match the requested worktree: ${why}`);
  if (!path.startsWith("/")) throw mismatch("no absolute path in its id");
  if (w.path && realpathSafe(w.path) !== realpathSafe(path)) throw mismatch(`path ${w.path}`);
  if (p.placement.kind === "new-child") {
    if (id.slice(0, sep) !== p.placement.repoId) throw mismatch(`repo is not ${p.placement.repoId}`);
    if (basename(path) !== p.placement.name) throw mismatch(`name is not ${p.placement.name}`);
    if (realpathSafe(path) === realpathSafe(p.top)) throw mismatch("it is the repository itself");
  } else {
    // A retry may resolve its original worktree from a repository subdirectory inside it.
    const want = realpathSafe(p.placement.selector.slice("path:".length)), real = realpathSafe(path);
    if (want !== real && !want.startsWith(real + "/")) throw mismatch(`path does not contain ${want}`);
  }
  return { id, path };
}

export interface LiveAnswerWorker { asked: TaskRecord; live: LiveWorker; worktree: string | null }

/**
 * Why the lane's agent cannot take input right now, or null when it can: the worker must be unsettled and the terminal
 * must still report the agent pacer launched. Orca types `--text` into whatever runs in the terminal. The agent is
 * launched with `exec`, so no shell sits behind it; this check is the second guard, and it fails closed.
 */
export async function liveAgentProblem(c: OrcaClient, live: LiveWorker): Promise<string | null> {
  const show = await c.workerShow(live.worker);
  if (!show.ok) return `worker-show failed: ${show.error.code}`;
  const state = show.result.worker?.state;
  if (!state || SETTLED_STATES.includes(state)) return `the worker is ${state ?? "gone"}`;
  const shown = await c.terminalShow(live.terminal);
  if (!shown.ok) return `terminal show failed: ${shown.error.code}`;
  const row = shown.result.terminal;
  if (!row || row.handle !== live.terminal) return "the terminal is gone";
  if (live.incarnation && row.incarnationId && row.incarnationId !== live.incarnation) return "the terminal was restarted";
  if (row.connected === false || row.writable === false) return "the terminal is not writable";
  if (row.agentIdentity !== live.agent) return row.agentIdentity ? `${row.agentIdentity}, not ${live.agent}, is in the foreground` : `${live.agent} is not in the foreground (a shell may be)`;
  return null;
}

/** Stop a live worker, close its terminal and forget it, as a settled attempt would. */
async function releaseLive(ctx: Ctx, c: OrcaClient, task: TaskRecord, why: string, log: (line: string) => void = () => {}): Promise<void> {
  const live = task.live;
  if (!live || live.backend !== "orca") return;
  log(`releasing live orca worker ${live.worker} of ${task.id}: ${why}`);
  const stopped = await c.workerStop(live.worker);
  log(`worker-stop: ${stopped.ok ? (stopped.result.state ?? "ok") : stopped.error.code}`);
  const closed = await closeCreatedTerminal(c, live.terminal);
  log(`closed pacer terminal ${live.terminal}: ${closed.failure ?? "ok"}`);
  if (!closed.proof) await recordUnclosed(ctx, task.id, live.terminal, log);
  await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[live.worker]; }); });
  updateTask(ctx, task.id, t => { if (t.live?.worker === live.worker) delete t.live; });
  taskActivity(ctx, task, "message", `Stopped the live ${live.agent} worker: ${why}`);
}

/**
 * An interactive lane's escalation (`pacer ask`) leaves its worker and terminal alive and recorded on the task
 * (`TaskRecord.live`). Answering it reattaches to that process instead of spawning a fresh worker, on every round: the
 * worker moves to each answering attempt in turn. A worker whose agent is gone, a retry that is not an answer, or an
 * answer routed to another executor releases the old worker first, so two agents never share one worktree.
 */
export async function findLiveAnswerWorker(ctx: Ctx, c: OrcaClient, task: TaskRecord, executor: string): Promise<LiveAnswerWorker | null> {
  // A plain `pacer delegate --interactive` answer creates a new, retryOf-linked task; a managed
  // (dispatch.child) answer restarts the same task id in place (src/core/work.ts `restartWork`).
  const asked = task.retryOf ? readTask(ctx, task.retryOf) : task;
  if (!asked?.live || asked.live.backend !== "orca") return null;
  const answering = task.retryOf ? asked.question?.answer !== undefined : task.brief.qa?.length;
  const problem = asked.interactionMode !== "conversation" ? "not an interactive lane"
    : !answering ? "a retry is not an answer" : asked.live.executor !== executor ? `the answer runs on ${executor}`
    : await liveAgentProblem(c, asked.live);
  if (problem) {
    await releaseLive(ctx, c, asked, problem).catch(() => { /* the supervision pass retries the release */ });
    return null;
  }
  const worker = loadOrcaState(ctx).workers[asked.live.worker];
  return { asked, live: asked.live, worktree: worker?.worktree ?? asked.worktree ?? null };
}

async function reattachOrcaAttempt(
  deps: OrcaBackendDeps, ctx: Ctx, c: OrcaClient, cfg: ProviderCfg, task: TaskRecord, reattach: LiveAnswerWorker,
): Promise<AttemptOutcome | null> {
  const { live, worktree } = reattach;
  const { worker: dispatchId, terminal } = live;
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return fallback(deps, ctx, cfg, task, undefined, git.error);
  const coord = await ensureCoordinator(ctx, c, git.top);
  if ("error" in coord) return fallback(deps, ctx, cfg, task, undefined, coord.error);
  const startedAt = deps.now() / 1000;
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  // The answering attempt takes ownership, so `pacer send` and the next answer find the worker under this task.
  const owned = { ...live, since: ctx.now };
  if (reattach.asked.id !== task.id) updateTask(ctx, reattach.asked.id, t => { if (t.live?.worker === dispatchId) delete t.live; });
  updateTask(ctx, task.id, t => { t.live = owned; if (worktree) t.worktree = worktree; });
  await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { if (s.workers[dispatchId]) s.workers[dispatchId].taskId = task.id; }); });
  const answerText = task.brief.qa?.at(-1)?.a;
  if (answerText) {
    // Checked again right before typing: setup above can take seconds, and the agent may have exited meanwhile.
    const problem = await liveAgentProblem(c, owned);
    const sent = problem ? null : await c.terminalSend(terminal, answerText);
    log(problem ? `did not deliver the answer: ${problem}` : `delivered the answer live to ${terminal}: ${sent!.ok ? "ok" : sent!.error.code}`);
    if (!sent?.ok) {
      await releaseLive(ctx, c, { ...task, live: owned }, problem ?? `the answer could not be delivered (${sent!.ok ? "" : sent!.error.code})`, log);
      return null;
    }
  } else {
    log(`reattached to ${dispatchId} with no live answer to deliver`);
  }
  const adm = deps.admission;
  const book = (what: string, f: () => unknown) => { try { f(); } catch (e) { log(`${what} failed: ${String(e instanceof Error ? e.message : e)}`); } };
  const admission = adm.begin(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
  book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal, ...(live.incarnation ? { incarnationId: live.incarnation } : {}) }));
  const prompt = buildPrompt({ ...task.brief, repo: worktree ? `the existing Orca worktree at ${worktree}` : task.brief.repo }, task.id);
  const before = await repoFingerprint(ctx, worktree ?? task.brief.repo);
  let keepAlive = false;
  let m: Mapped;
  let endedAt: number;
  let tailText = "";
  try {
    const waited = await waitForWorker(ctx, c, {
      taskId: task.id, providerId: cfg.id, prompt, coordinator: coord.coordinator, run: coord.run, dispatchId, terminal,
      deadlineMs: deps.now() + task.timeoutS * 1000,
      isStopped: () => readTask(ctx, task.id)?.state === "stopped",
      sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log,
    });
    log(waitLine(dispatchId, waited));
    m = mapWait(waited);
    endedAt = deps.now() / 1000;
    tailText = m.tail ?? "";
    if (m.code !== 0 && m.tail === undefined) {
      const rd = await c.workerRead(dispatchId, 60);
      tailText = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
    }
    keepAlive = waited.kind === "settled" && waited.state === "needs_input";
    if (keepAlive) log(`keeping orca worker ${dispatchId} alive for another live answer; task is needs_input`);
    else await settle(c, dispatchId, m.settled, log, receipt => book("admission receipt", () => adm.finishOrca(ctx, admission, receipt)));
  } catch (e) {
    try {
      const receipt = await c.workerStop(dispatchId);
      log(`worker-stop: ${receipt.ok ? (receipt.result.state ?? "ok") : receipt.error.code}`);
      book("admission receipt", () => adm.finishOrca(ctx, admission, receipt));
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    throw e;
  } finally {
    if (keepAlive) {
      book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) t.live.since = deps.now() / 1000; }));
      book("admission release", () => adm.finish(ctx, admission));
    } else {
      const closed = await closeCreatedTerminal(c, terminal);
      log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) book("admission release", () => adm.finish(ctx, admission));
      else await recordUnclosed(ctx, task.id, terminal, log);
      try {
        await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[dispatchId]; }); });
      } catch (e) { log(`worker state cleanup failed: ${String(e)}`); }
      book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) delete t.live; }));
    }
  }
  const exec: ExecResult = { code: m.code, stdout: m.summary, stderr: tailText, timedOut: m.timedOut };
  const after = await repoFingerprint(ctx, worktree ?? task.brief.repo);
  const reason = brokenReason(exec, endedAt - startedAt, before === null && after === null ? null : before !== null && before === after);
  const dir = tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, `${task.id}.${cfg.id}.log`);
  await Bun.write(logFile, `${lines.join("\n")}\n--- summary\n${m.summary}\n--- worker output (tail)\n${tailText}\n`);
  return {
    exec, report: tail(m.summary, REPORT_CHARS), backend: "orca", ...(worktree ? { worktree } : {}),
    attempt: {
      executor: cfg.id, model: cfg.model, startedAt, endedAt, ...(reason ? { brokenReason: reason } : {}),
      exitCode: m.code, timedOut: m.timedOut, limitHit: !reason && detectLimit(cfg.id, exec), log: logFile,
    },
  };
}

async function runOrcaAttempt(
  deps: OrcaBackendDeps, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn?: (pid: number) => void,
): Promise<AttemptOutcome> {
  let ex: ExecutionCfg;
  try {
    ex = deps.loadExecution(ctx);
  } catch (e) {
    return fallback(deps, ctx, cfg, task, onSpawn, (e as Error).message);
  }
  // A work grant is a secret: it cannot go in a visible Orca terminal command, so delegating work runs directly.
  if (ctx.env.PACER_WORK_GRANT) return fallback(deps, ctx, cfg, task, onSpawn, "the task allows delegation, and its work grant cannot be placed in a visible Orca terminal command");
  const c = new OrcaClient(ctx.run, ctx.env);
  const reattach = await findLiveAnswerWorker(ctx, c, task, cfg.id);
  const reattached = reattach && await reattachOrcaAttempt(deps, ctx, c, cfg, task, reattach);
  if (reattached) return reattached;
  let p: Prepared;
  try {
    p = await prepare(ctx, c, cfg, task, ex);
  } catch (e) {
    return fallback(deps, ctx, cfg, task, onSpawn, String(e instanceof Error ? e.message : e));
  }
  if (!p.ok) {
    if(p.refuse){const at=Date.now()/1000;return {exec:{code:1,stdout:"",stderr:p.reason,timedOut:false},report:p.reason,backend:"orca",attempt:{executor:cfg.id,model:cfg.model,startedAt:at,endedAt:at,exitCode:1,timedOut:false,limitHit:false,log:""}};}
    return fallback(deps, ctx, cfg, task, onSpawn, p.reason);
  }

  updateTask(ctx,task.id,t=>{t.baseBranch=p.base;t.placement={requested:task.placement?.requested??"auto",...task.placement,...p.resolved};if (!task.retryOf) delete t.worktree;});
  let startedAt = deps.now() / 1000;
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const adm = deps.admission;
  // Admission bookkeeping must never skip terminal close or supervision.
  const book = (what: string, f: () => unknown) => { try { f(); } catch (e) { log(`${what} failed: ${String(e instanceof Error ? e.message : e)}`); } };
  const unstarted = async (report: string): Promise<AttemptOutcome> => {
    const dir = tasksDir(ctx);
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, `${task.id}.${cfg.id}.log`);
    await Bun.write(logFile, [...lines, "--- summary", report].join("\n") + "\n");
    return {
      exec: { code: 1, stdout: report, stderr: "", timedOut: false }, report, backend: "orca",
      attempt: {
        executor: cfg.id, model: cfg.model, startedAt, endedAt: deps.now() / 1000,
        exitCode: 1, timedOut: false, limitHit: false, log: logFile,
      },
    };
  };
  const prompt = workerSpec(task, p);
  const admission = adm.begin(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
  let terminal: string | null = null;
  let created: OwnedWorktree | null = null;
  let worktree: string | null = null;
  let selector = "";
  let incarnationId: string | undefined;
  // Orca opens its own shell terminal in a new worktree; the create reply may not name it, so list the worktree.
  // That shell is not pacer work: the session lease is never bound to it, and an unproven close is only retried by pacer clean.
  const strays: string[] = [], unproven: string[] = [];
  const closeStrays = async (w: OwnedWorktree, reply: TerminalRow[], when: string) => {
    const listed = await worktreeTerminals(c, w.id, [...strays, ...(terminal ? [terminal] : [])]);
    if (!listed) {
      log(`orca terminal list for ${w.id} failed or was truncated; Orca's initial terminal may stay open`);
      // Only handles known before pacer's agent terminal exists are Orca's own; a later terminal may be the user's.
      await recordStrayRisk(ctx, task.id, w, terminal ? [] : reply.map(t => t.handle), log);
    }
    const rows = [...reply, ...(listed ?? [])].filter((t, i, all) => all.findIndex(x => x.handle === t.handle) === i);
    for (const t of rows) {
      const closed = await closeCreatedTerminal(c, t.handle);
      log(`closed Orca initial terminal ${t.handle}${when}: ${closed.failure ?? "ok"}`);
      if (closed.proof) { strays.push(t.handle); continue; }
      unproven.push(t.handle);
      await recordUnclosed(ctx, task.id, t.handle, log, w.id);
    }
    if (unproven.length) throw Error(`orca worktree initial terminal ${unproven.join(", ")} could not be verified closed`);
  };
  const worktreeId = () => selector ? selector.slice("id:".length) : undefined;
  const discard = async () => { if (created) await discardCreatedWorktree(ctx, c, task.id, created, log, { sleep: deps.sleep }); };
  try {
    const kind = p.placement.kind === "new-child" ? "create" : "show";
    const placement = p.placement.kind === "new-child"
      ? await c.worktreeCreate(p.placement)
      : await c.worktreeShow(realpathSafe(p.placement.selector.slice("path:".length)));
    if (!placement.ok) throw Error(`orca worktree ${kind} failed: ${placement.error.code} ${placement.error.message}`);
    // Older Orca replies named the initial terminal; current ones do not.
    const named = placement.result.terminal?.handle ?? placement.result.initialTerminalHandle ?? placement.result.terminalHandle;
    const initial: TerminalRow[] = p.placement.kind === "new-child" && named
      ? [{handle: named, ...(placement.result.terminal?.handle === named && placement.result.terminal.incarnationId ? {incarnationId: placement.result.terminal.incarnationId} : {})}] : [];
    let checked: { id: string; path: string };
    try { checked = checkedWorktree(p, placement.result.worktree); }
    catch (e) {
      if (p.placement.kind === "new-child") log(`Orca worktree ${placement.result.worktree?.id ?? "(no id)"} not removed: its identity is unverified`);
      throw e;
    }
    const { id, path: root } = checked;
    if (p.placement.kind === "new-child") created = { id, path: root, name: p.placement.name };
    selector = `id:${id}`;
    log(`worktree ${kind} ${id}: ${root}`);
    if (created) await closeStrays(created, initial, "");
    worktree = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
      : p.sub ? join(root, p.sub) : root;
    const accountEnv = await providerEnv(ctx, cfg);
    if (Object.keys(accountEnv).some(key => key !== "CLAUDE_CONFIG_DIR" && key !== "CODEX_HOME")) {
      throw Error("account environment contains values that cannot be placed in a visible Orca terminal command");
    }
    // CLAUDE_CODE_SANDBOXED makes Claude treat the folder as trusted without writing its configuration.
    const identity = ["PACER_ROLE=executor", `PACER_TASK_ID=${task.id}`, ...(p.agent === "claude" ? ["CLAUDE_CODE_SANDBOXED=1"] : [])];
    // As in a direct launch, a default account uses the folder the user's login profile sets. Orca's shell environment
    // is not the service's, so without a profile folder a default account must not inherit another account's home.
    const agent = p.agent === "claude" ? "claude-code" : "codex", home = p.agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    const base = await deps.terminalEnv(ctx).catch((e): TerminalEnv => ({env: ctx.env, source: "service", reason: String(e)}));
    recordDefaultFolder(ctx, agent, accountEnv, base);
    const profileHome = !(home in accountEnv) && profileKeys(base).includes(home) ? base.env[home] : undefined;
    const folders: Record<string, string> = {...(profileHome?.startsWith("/") ? {[home]: profileHome} : {}), ...accountEnv};
    const unset = home in folders ? [] : ["-u", home];
    // As in a direct launch in a pacer task worktree, a worktree pacer created for this task (new-child, identity
    // verified above) carries the source checkout's MCP answers, so project servers are approved and rejected ones stay
    // off. Read-only, from the account Claude uses in this terminal; .claude.json is never written (trust is
    // CLAUDE_CODE_SANDBOXED). An existing or retry placement keeps Claude's MCP prompt.
    let mcp: McpChoices | undefined;
    if (agent === "claude-code") {
      const answers = created
        ? projectMcpChoices(claudeConfigFile({...base.env, CLAUDE_CONFIG_DIR: folders.CLAUDE_CONFIG_DIR}, ctx.home), [task.brief.repo, p.top, p.main])
        : {reason: "only pacer-created task worktrees are"};
      if ("reason" in answers) log(mcpNotApproved(answers.reason));
      else mcp = answers;
    }
    // The direct interactive launch for this runner and worktree, with its per-run settings file (bypass-permissions
    // acknowledgement, MCP answers). pacer's PTY session hooks stay out: Orca supervises this terminal.
    const launch = prepareInteractive(agent, `${runDir(ctx, task.id, task.attempts.length + 1)}-orca`,
      {cwd: root, argv: launchArgvFor(cfg, root, tasksDir(ctx), p.top)}, {sessionHooks: false, ...(mcp ? {mcp} : {})}).argv;
    // `exec` replaces the terminal's login shell with the agent: when the agent exits the terminal ends, so no shell is
    // ever left behind it to receive text typed for the agent (`task.send`, a live answer).
    const command = shellCommand(["exec", "env", ...unset, ...identity, ...Object.entries(folders).map(([key, value]) => `${key}=${value}`), ...launch]);
    const shown = shellCommand(["exec", "env", ...unset, ...identity, ...Object.keys(folders).map(key => `${key}=<${key}>`), ...launch]);
    const made = await c.terminalCreate(selector, `pacer ${task.id}`, command);
    if (!made.ok || !made.result.terminal?.handle) throw Error(`orca terminal create failed: ${made.ok ? "no handle" : `${made.error.code} ${made.error.message}`}`);
    terminal = made.result.terminal.handle;
    log(`terminal create ${terminal}: ${shown}`);
    incarnationId = made.result.terminal.incarnationId;
    adm.bind(ctx, admission, {dispatchId: "pending", terminal, ...(incarnationId ? {incarnationId} : {})});
    const idle = await c.terminalWait(terminal);
    const state = idle.ok ? (idle.result.wait?.satisfied === true ? "idle" : idle.result.wait?.blockedReason ?? idle.result.wait?.status ?? "timeout") : `${idle.error.code} ${idle.error.message}`;
    log(`terminal wait ${terminal}: ${state}`);
    if (state !== "idle") throw Error(`orca terminal did not become idle: ${state}`);
  } catch (e) {
    let reason = String(e instanceof Error ? e.message : e);
    let closed = !terminal;
    if (terminal) {
      const result = await closeCreatedTerminal(c, terminal);
      log(`closed pacer terminal ${terminal}: ${result.failure ?? "ok"}`);
      closed = result.proof;
      if (result.failure) reason += `; terminal close failed ${terminal}: ${result.failure}`;
      if (!result.proof && !unproven.includes(terminal)) await recordUnclosed(ctx, task.id, terminal, log, worktreeId());
    }
    await discard();
    if (closed) book("admission release", () => adm.finish(ctx, admission));
    return fallback(deps, ctx, cfg, task, onSpawn, reason, lines);
  }
  const agentTerminal: string = terminal!;
  let r: WorkerStartResult | null = null;
  let uncertain: string | null = null;
  try {
    const ws = await c.workerStart({ spec: prompt, terminal: agentTerminal, worktree: selector, run: p.run, from: p.coordinator });
    if (ws.ok && ws.result.dispatchId) r = ws.result;
    else if (!ws.ok && ws.error.code === "task_not_startable") {
      log(`worker-start refused: ${ws.error.code} ${ws.error.message}`);
      const closed = await closeCreatedTerminal(c, agentTerminal);
      log(`closed pacer terminal ${agentTerminal}: ${closed.failure ?? "ok"}`);
      if (!closed.proof) await recordUnclosed(ctx, task.id, agentTerminal, log, worktreeId());
      await discard();
      if (closed.proof) book("admission release", () => adm.finish(ctx, admission));
      return fallback(deps, ctx, cfg, task, onSpawn, `orca worker-start refused (${ws.error.code}: ${ws.error.message})`
        + (closed.failure ? `; terminal close failed ${agentTerminal}: ${closed.failure}` : ""), lines);
    } else uncertain = ws.ok ? "orca worker-start returned no dispatch id" : `${ws.error.code}: ${ws.error.message}`;
  } catch (e) {
    uncertain = String(e instanceof Error ? e.message : e);
  }
  if (uncertain) {
    log(`worker-start uncertain: ${uncertain}`);
    // Never fall back while a worker may exist: look the terminal's dispatch up, a bounded number of times.
    let found: WorkerLookup = { kind: "unknown", reason: "not checked" };
    for (let i = 0; i < 3; i++) {
      if (i) await deps.sleep(5_000);
      found = await lookupWorker(c, p.run, agentTerminal);
      log(`worker-list ${p.run} for ${agentTerminal}: ${found.kind === "found" ? `${found.dispatchId} ${found.state}` : found.kind === "none" ? "no worker" : found.reason}`);
      if (found.kind === "found") break;
    }
    const keep = async (why: string) => {
      try {
        await withLock(ctx, "coordinator", async () => {
          updateOrcaState(ctx, s => { s.uncertain[agentTerminal] = { taskId: task.id, terminal: agentTerminal, run: p.run, worktree: created, at: ctx.now }; });
        });
      } catch (e) { log(`recording uncertain start failed: ${String(e)}`); }
      log(`kept terminal ${agentTerminal} (run ${p.run}) and its work lease for later reconciliation: ${why}`);
    };
    if (found.kind === "none") {
      const closed = await closeCreatedTerminal(c, agentTerminal);
      log(`closed pacer terminal ${agentTerminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) {
        book("admission release", () => adm.finish(ctx, admission));
        await discard();
      } else await keep(`terminal close failed: ${closed.failure}`);
      return unstarted(`Orca did not create the worker (${uncertain}). Direct fallback was skipped.`);
    }
    if (found.kind === "unknown") {
      await keep(found.reason);
      return unstarted(`pacer cannot tell whether Orca created the worker: ${uncertain}. Direct fallback was skipped to avoid duplicate execution; terminal ${agentTerminal} is kept for reconciliation.`);
    }
    r = { dispatchId: found.dispatchId, state: found.state === "failed" ? "failed" : "ready" };
  }
  startedAt = deps.now() / 1000;
  const start = r!;
  const dispatchId = start.dispatchId!;
  // Every rebind keeps the create-time incarnation, so a later pass can still prove the terminal closed.
  book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal: agentTerminal, ...(incarnationId ? { incarnationId } : {}) }));
  if (!incarnationId) {
    try {
      const shown = await c.terminalShow(agentTerminal);
      if (shown.ok && shown.result.terminal?.handle === agentTerminal && shown.result.terminal.incarnationId) {
        const shownId = shown.result.terminal.incarnationId;
        incarnationId = shownId;
        book("admission binding", () => adm.bind(ctx, admission, { dispatchId, terminal: agentTerminal, incarnationId: shownId }));
      }
    } catch { /* No precise terminal identity: retain the lease until a closure receipt. */ }
  }
  log(`worker-start ${dispatchId}: ${start.state ?? "unknown"} (agent ${p.agent}${p.model ? `, model ${p.model}` : ""}, worktree ${worktree ?? "-"})`);
  const forget = async () => {
    try {
      await withLock(ctx, "coordinator", async () => {
        updateOrcaState(ctx, (s) => { delete s.workers[dispatchId]; });
      });
    } catch (e) {
      log(`worker state cleanup failed: ${String(e)}`);
    }
  };
  let m: Mapped;
  let before: string | null = null;
  let launchBroken: string | undefined;
  let endedAt: number;
  let tailText = "";
  let keepAlive = false;
  try {
    try {
      // Once started, even a task/worker registration failure must keep supervision active.
      if(worktree)updateTask(ctx,task.id,t=>{t.worktree=worktree;});
      await withLock(ctx, "coordinator", async () => {
        updateOrcaState(ctx, (s) => {
          s.workers[dispatchId] = { dispatchId, taskId: task.id, executor: cfg.id, worktree, terminal: agentTerminal, startedAt };
        });
      });
      // An interactive lane's worker is owned through the task, so `pacer send` and `task.stop` can reach it.
      if (task.interactionMode === "conversation") updateTask(ctx, task.id, t => {
        t.live = { backend: "orca", worker: dispatchId, terminal: agentTerminal, executor: cfg.id, agent: p.agent, ...(incarnationId ? { incarnation: incarnationId } : {}), since: startedAt };
      });
    } catch (e) {
      log(`worker registration failed; continuing supervision: ${String(e)}`);
    }
    if (p.placement.kind === "new-child" && !worktree) {
      throw new Error(`orca worker ${dispatchId} returned no worktree path for new-child placement; stopped it without verifying the original repository`);
    }
    if (start.state !== "ready") {
      if (/agent[ _-]?launch|launch[ _-]?agent/i.test(start.failedStage ?? "")) {
        launchBroken = `orca agent launch failed: ${start.lastError ?? "no error given"}`;
      }
      m = {
        code: 1, timedOut: false, settled: true,
        summary: `orca worker failed to start at ${start.failedStage ?? start.stage ?? "an unknown stage"}: ${start.lastError ?? "no error given"}`,
      };
    } else {
      before = await repoFingerprint(ctx, worktree ?? task.brief.repo);
      const w = await waitForWorker(ctx, c, {
        taskId: task.id, providerId: cfg.id, prompt, coordinator: p.coordinator, run: p.run, dispatchId, terminal: agentTerminal,
        deadlineMs: deps.now() + task.timeoutS * 1000,
        isStopped: () => readTask(ctx, task.id)?.state === "stopped",
        sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log,
      });
      log(waitLine(dispatchId, w));
      m = mapWait(w);
      // Kept alive only while the task records it as its owner; otherwise stop, release and the reaper could not reach it.
      keepAlive = task.interactionMode === "conversation" && w.kind === "settled" && w.state === "needs_input"
        && readTask(ctx, task.id)?.live?.worker === dispatchId;
    }

    endedAt = deps.now() / 1000;
    tailText = m.tail ?? "";
    if (m.code !== 0 && m.tail === undefined) {
      const rd = await c.workerRead(dispatchId, 60);
      tailText = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
    }
    // An interactive lane's escalation leaves its worker and terminal running, so a live
    // `pacer send`/`pacer answer` can deliver into the same process instead of respawning it.
    if (keepAlive) log(`keeping orca worker ${dispatchId} alive for a live answer; task is needs_input`);
    else await settle(c, dispatchId, m.settled, log, receipt => book("admission receipt", () => adm.finishOrca(ctx, admission, receipt)));
  } catch (e) {
    keepAlive = false;
    try {
      const receipt = await c.workerStop(dispatchId);
      log(`worker-stop: ${receipt.ok ? (receipt.result.state ?? "ok") : receipt.error.code}`);
      book("admission receipt", () => adm.finishOrca(ctx, admission, receipt));
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    throw e;
  } finally {
    if (keepAlive) {
      // The worker stays registered and owned by the task (`live`), holding its slot, until an answer reattaches to it
      // or task.stop, settlement or the idle limit releases it (src/exec/live.ts).
      book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) t.live.since = deps.now() / 1000; }));
      book("admission release", () => adm.finish(ctx, admission));
    } else {
      // Always close the exact terminal pacer created; nothing above may skip this.
      const closed = await closeCreatedTerminal(c, agentTerminal);
      log(`closed pacer terminal ${agentTerminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) book("admission release", () => adm.finish(ctx, admission));
      else await recordUnclosed(ctx, task.id, agentTerminal, log, worktreeId());
      await forget();
      book("live worker", () => updateTask(ctx, task.id, t => { if (t.live?.worker === dispatchId) delete t.live; }));
    }
  }

  const exec: ExecResult = { code: m.code, stdout: m.summary, stderr: tailText, timedOut: m.timedOut };
  const after = await repoFingerprint(ctx, worktree ?? task.brief.repo);
  const transient = m.summary.includes("transient provider busy after three retries") ? "transient provider busy after three retries" : null;
  const reason = transient ?? launchBroken ?? brokenReason(exec, endedAt - startedAt, before === null && after === null ? null : before !== null && before === after);
  const dir = tasksDir(ctx);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, `${task.id}.${cfg.id}.log`);
  await Bun.write(logFile, `${lines.join("\n")}\n--- summary\n${m.summary}\n--- worker output (tail)\n${tailText}\n`);
  return {
    exec,
    report: tail([...p.notes, m.summary].join("\n\n"), REPORT_CHARS),
    backend: "orca",
    ...(worktree ? { worktree } : {}),
    attempt: {
      executor: cfg.id, model: cfg.model, startedAt, endedAt,
      ...(reason ? { brokenReason: reason } : {}),
      exitCode: m.code, timedOut: m.timedOut, limitHit: !transient && detectLimit(cfg.id, exec), log: logFile,
    },
  };
}

export function makeOrcaBackend(over: Partial<OrcaBackendDeps> = {}): Backend {
  const deps: OrcaBackendDeps = { ...DEFAULTS, ...over };
  return {
    id: "orca",
    available: async (ctx, s) => {
      const ex = validateExecution(s.execution);
      if (ex.backend !== "orca" && ctx.env.PACER_BACKEND !== "orca") return false;
      return isReady(await new OrcaClient(ctx.run, ctx.env).status());
    },
    runAttempt: (ctx, cfg, task, onSpawn) => runOrcaAttempt(deps, ctx, cfg, task, onSpawn),
    live: {
      send: async (ctx, task, text) => {
        if (!task.live || task.live.backend !== "orca") return { ok: false, code: "unavailable", message: "this task has no live terminal to send into" };
        const c = new OrcaClient(ctx.run, ctx.env);
        const problem = await liveAgentProblem(c, task.live);
        if (problem) return { ok: false, code: "unavailable", message: `refused: ${problem}. Nothing was typed; answer or retry the task instead` };
        const sent = await c.terminalSend(task.live.terminal, text);
        return sent.ok ? { ok: true } : { ok: false, code: "unavailable", message: `orca terminal send failed: ${sent.error.code} ${sent.error.message}` };
      },
      release: (ctx, task, why) => releaseLive(ctx, new OrcaClient(ctx.run, ctx.env), task, why),
    },
  };
}

/** Supervised Orca workers, one worktree per attempt (spec §3.5). */
export const orcaBackend: Backend = makeOrcaBackend();
