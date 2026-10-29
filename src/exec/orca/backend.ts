import { beginWorkSync, bindOrcaWorkSync, finishOrcaWorkSync, finishWorkSync } from "../../update/desktop/admission";
import { resolveWorktreeBase } from "../../supervisor/worktree";
import { pidAlive } from "../../link/store";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../fsutil";
import { type ExecutionCfg, validateExecution } from "../../config/execution";
import { type ProviderCfg, loadStrategy } from "../../config/strategy";
import { readTask, tasksDir, listTasksWhere, updateTask } from "../../tasks/store";
import { resolvePlacement, type ResolvedPlacement, type TaskRecord } from "../../tasks/types";
import type { Ctx } from "../../types";
import type { Backend } from "../backend";
import { type AttemptOutcome, REPORT_CHARS, runAttempt as directAttempt, tail } from "../direct";
import { detectLimit } from "../limits";
import { brokenReason, repoFingerprint } from "../broken";
import type { ExecResult } from "../process";
import { buildPrompt } from "../prompt";
import { orcaAgentFor } from "./agents";
import { OrcaClient, type Placement, agentTerminalOf, isReady, worktreePathOf } from "./client";
import { ensureCoordinator, ensureGroupWorktree, ensureRepo, gitInfo, realpathSafe } from "./setup";
import { loadOrcaState, updateOrcaState, withLock } from "./state";
import { SETTLED_STATES, type WaitResult, waitForWorker } from "./wait";

export interface OrcaBackendDeps {
  loadExecution: (ctx: Ctx) => ExecutionCfg;
  direct: Backend["runAttempt"];
  sliceMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULTS: OrcaBackendDeps = {
  loadExecution: (ctx) => validateExecution(loadStrategy(ctx).execution),
  direct: directAttempt,
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
  base: string;
  sub: string;
  notes: string[];
  resolved: ResolvedPlacement;
  /** Set when `prepare()` itself created the worktree (a `--group` lane's own `worktree create` call), so the caller doesn't have to infer a fresh path from `placement.kind === "existing"`, which also covers plain current-worktree and retry-reuse placements. */
  newWorktree?: string;
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
  let placement: Placement;
  let newWorktree: string | undefined;
  if (task.retryOf && task.worktree) {
    placement = { kind: "existing", selector: `path:${task.worktree}` };
  } else if (resolved.mode !== "current" && task.group) {
    const group = await ensureGroupWorktree(ctx, c, repoId, task.group, resolvedBase.sha ?? base);
    if ("error" in group) return { ok: false, reason: group.error };
    const lane = await c.worktreeCreate({ repoId, name: `pacer-${task.id}-${cfg.id}`, baseBranch: resolvedBase.sha ?? base, parentWorktree: group.selector });
    if (!lane.ok) return { ok: false, reason: `orca worktree create failed: ${lane.error.code} ${lane.error.message}` };
    const path = lane.result.worktree?.path;
    if (!path) return { ok: false, reason: "orca worktree create returned no path" };
    placement = { kind: "existing", selector: `path:${path}` };
    newWorktree = path;
  } else if (resolved.mode !== "current") {
    placement = { kind: "new-child", repoId, baseBranch: resolvedBase.sha ?? base, name: `pacer-${task.id}-${cfg.id}` };
  } else {
    placement = { kind: "existing", selector: `path:${git.top}` };
  }
  return {
    ok: true, agent: mapped.agent, model: mapped.model, coordinator: coord.coordinator, run: coord.run,
    placement, top: git.top, base, sub: git.sub, notes, resolved, ...(newWorktree ? { newWorktree } : {}),
  };
}

function workerSpec(task: TaskRecord, p: Ready): string {
  const where = p.newWorktree
    ? `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}, grouped under ${task.group}. Do not edit ${p.top} itself.`
    : p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
    : `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}` +
      `${p.sub ? `. Work in its ${p.sub}/ subdirectory` : ""}. Do not edit ${p.top} itself.`;
  const prompt = buildPrompt({ ...task.brief, repo: where }, task.id);
  // Orca worker-start has no environment option. Supply identity on the ask command itself.
  const command = 'run pacer ask "<one question>"';
  const at = prompt.lastIndexOf(command);
  return prompt.slice(0, at) + `run PACER_ROLE=executor PACER_TASK_ID=${task.id} pacer ask "<one question>"` + prompt.slice(at + command.length);
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
  deps: OrcaBackendDeps, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn: ((pid: number) => void) | undefined, reason: string,
): Promise<AttemptOutcome> {
  const out = await deps.direct(ctx, cfg, task, onSpawn);
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

async function cleanup(c: OrcaClient, dispatchId: string, terminal: string | null, settled: boolean, log: (l: string) => void, receipt: (reply: Awaited<ReturnType<OrcaClient["workerStop"]>>) => void) {
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
  if (terminal) {
    const t = await c.terminalShow(terminal);
    if (t.ok && t.result.terminal?.connected) {
      const cl = await c.terminalClose(terminal);
      log(`closed orphaned agent terminal ${terminal}: ${cl.ok ? "ok" : cl.error.code}`);
    }
  }
}

export interface LiveAnswerWorker { dispatchId: string; terminal: string | null; worktree: string | null }

/**
 * An interactive lane's escalation (`pacer ask`) leaves its worker and terminal alive instead of
 * stopping them (see `keepAlive` in `runOrcaAttempt`). Answering that question reattaches to the
 * same process — delivering the answer live — instead of spawning a fresh worker, as long as the
 * worker is still running and the retry is for the same executor it was asked on.
 */
export async function findLiveAnswerWorker(ctx: Ctx, c: OrcaClient, task: TaskRecord, executor: string): Promise<LiveAnswerWorker | null> {
  // A plain `pacer delegate --interactive` answer creates a new, retryOf-linked task; a managed
  // (dispatch.child) answer restarts the same task id in place (src/core/work.ts `restartWork`).
  // Either way, the live worker to reattach to is registered under the id that actually asked.
  const askedId = task.retryOf ? (readTask(ctx, task.retryOf)?.interactionMode === "conversation" ? task.retryOf : null)
    : task.interactionMode === "conversation" ? task.id : null;
  if (!askedId) return null;
  const worker = Object.values(loadOrcaState(ctx).workers).find(w => w.taskId === askedId);
  if (!worker || worker.executor !== executor) return null;
  const show = await c.workerShow(worker.dispatchId);
  if (!show.ok || !show.result.worker?.state || SETTLED_STATES.includes(show.result.worker.state)) return null;
  return { dispatchId: worker.dispatchId, terminal: worker.terminal, worktree: worker.worktree };
}

async function reattachOrcaAttempt(
  deps: OrcaBackendDeps, ctx: Ctx, c: OrcaClient, cfg: ProviderCfg, task: TaskRecord, reattach: LiveAnswerWorker,
): Promise<AttemptOutcome> {
  const { dispatchId, terminal, worktree } = reattach;
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return fallback(deps, ctx, cfg, task, undefined, git.error);
  const coord = await ensureCoordinator(ctx, c, git.top);
  if ("error" in coord) return fallback(deps, ctx, cfg, task, undefined, coord.error);
  const startedAt = deps.now() / 1000;
  const lines: string[] = [];
  const log = (line: string) => { lines.push(line); };
  const admission = beginWorkSync(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
  bindOrcaWorkSync(ctx, admission, { dispatchId, terminal });
  const answerText = task.brief.qa?.at(-1)?.a;
  if (worktree) updateTask(ctx, task.id, t => { t.worktree = worktree; });
  if (answerText && terminal) {
    const sent = await c.terminalSend(terminal, answerText);
    log(`delivered the answer live to ${terminal}: ${sent.ok ? "ok" : sent.error.code}`);
  } else {
    log(`reattached to ${dispatchId} with no live answer to deliver`);
  }
  const prompt = buildPrompt({ ...task.brief, repo: worktree ? `the existing Orca worktree at ${worktree}` : task.brief.repo }, task.id);
  const before = await repoFingerprint(ctx, worktree ?? task.brief.repo);
  try {
    const waited = await waitForWorker(ctx, c, {
      taskId: task.id, providerId: cfg.id, prompt, coordinator: coord.coordinator, run: coord.run, dispatchId, terminal,
      deadlineMs: deps.now() + task.timeoutS * 1000,
      isStopped: () => readTask(ctx, task.id)?.state === "stopped",
      sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log,
    });
    const m = mapWait(waited);
    const endedAt = deps.now() / 1000;
    let tailText = m.tail ?? "";
    if (m.code !== 0 && m.tail === undefined) {
      const rd = await c.workerRead(dispatchId, 60);
      tailText = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
    }
    const keepAlive = task.interactionMode === "conversation" && waited.kind === "settled" && waited.state === "needs_input";
    if (keepAlive) {
      log(`keeping orca worker ${dispatchId} alive for another live answer; task is needs_input`);
      finishWorkSync(ctx, admission);
    } else {
      await cleanup(c, dispatchId, terminal, m.settled, log, receipt => { finishOrcaWorkSync(ctx, admission, receipt); });
      await withLock(ctx, "coordinator", async () => { updateOrcaState(ctx, s => { delete s.workers[dispatchId]; }); });
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
  } catch (e) {
    try {
      const receipt = await c.workerStop(dispatchId);
      finishOrcaWorkSync(ctx, admission, receipt);
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    throw e;
  }
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
  const c = new OrcaClient(ctx.run, ctx.env);
  const reattach = await findLiveAnswerWorker(ctx, c, task, cfg.id);
  if (reattach) return reattachOrcaAttempt(deps, ctx, c, cfg, task, reattach);
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
  const uncertainStart = async (reason: string): Promise<AttemptOutcome> => {
    const report = `pacer cannot tell whether Orca created the worker: ${reason}. Direct fallback was skipped to avoid duplicate execution.`;
    const dir = tasksDir(ctx);
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, `${task.id}.${cfg.id}.log`);
    await Bun.write(logFile, report + "\n");
    return {
      exec: { code: 1, stdout: report, stderr: "", timedOut: false }, report, backend: "orca",
      attempt: {
        executor: cfg.id, model: cfg.model, startedAt, endedAt: deps.now() / 1000,
        exitCode: 1, timedOut: false, limitHit: false, log: logFile,
      },
    };
  };
  let ws: Awaited<ReturnType<OrcaClient["workerStart"]>>;
  const prompt = workerSpec(task, p);
  const admission = beginWorkSync(ctx, { kind: "session", id: task.id, label: `Orca session ${task.id}` });
  try {
    ws = await c.workerStart({ spec: prompt, agent: p.agent, model: p.model, placement: p.placement, run: p.run, from: p.coordinator });
  } catch (e) {
    return uncertainStart(String(e instanceof Error ? e.message : e));
  }
  if (!ws.ok && ["timeout", "bad_output"].includes(ws.error.code)) {
    return uncertainStart(`${ws.error.code}: ${ws.error.message}`);
  }
  if (!ws.ok) {
    if (ws.error.code !== "task_not_startable") return uncertainStart(`${ws.error.code}: ${ws.error.message}`);
    finishWorkSync(ctx, admission);
    // A definite refusal (not an ambiguous timeout/bad_output) means Orca never attached a worker
    // to the worktree prepare() just created for a --group lane: safe to remove it rather than
    // leave an orphan with no task ever referencing it.
    let cleanup = "";
    if (p.newWorktree) {
      try {
        const rm = await c.worktreeRemove(`path:${p.newWorktree}`);
        cleanup = `; removed orphaned group worktree ${p.newWorktree}: ${rm.ok ? "ok" : rm.error.code}`;
      } catch (e) {
        cleanup = `; failed to remove orphaned group worktree ${p.newWorktree}: ${String(e)}`;
      }
    }
    return fallback(deps, ctx, cfg, task, onSpawn, `orca worker-start refused (${ws.error.code}: ${ws.error.message})${cleanup}`);
  }
  startedAt = deps.now() / 1000;
  const r = ws.result;
  if (!r.dispatchId) return uncertainStart("orca worker-start returned no dispatch id");
  const dispatchId = r.dispatchId;
  const root = worktreePathOf(r.effects);
  const worktree = p.newWorktree ?? (p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo) : root ? (p.sub ? join(root, p.sub) : root) : null);
  const terminal = agentTerminalOf(r.effects);
  bindOrcaWorkSync(ctx, admission, { dispatchId, terminal });
  if (terminal) {
    try {
      const shown = await c.terminalShow(terminal);
      if (shown.ok && shown.result.terminal?.handle === terminal && shown.result.terminal.incarnationId) {
        bindOrcaWorkSync(ctx, admission, { dispatchId, terminal, incarnationId: shown.result.terminal.incarnationId });
      }
    } catch { /* No precise terminal identity: retain the lease until a closure receipt. */ }
  }
  log(`worker-start ${dispatchId}: ${r.state ?? "unknown"} (agent ${p.agent}${p.model ? `, model ${p.model}` : ""}, worktree ${worktree ?? "-"})`);
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
  let waited: WaitResult | undefined;
  try {
    try {
      // Once started, even a task/worker registration failure must keep supervision active.
      if(worktree)updateTask(ctx,task.id,t=>{t.worktree=worktree;});
      await withLock(ctx, "coordinator", async () => {
        updateOrcaState(ctx, (s) => {
          s.workers[dispatchId] = { dispatchId, taskId: task.id, executor: cfg.id, worktree, terminal, startedAt };
        });
      });
    } catch (e) {
      log(`worker registration failed; continuing supervision: ${String(e)}`);
    }
    if (p.placement.kind === "new-child" && !worktree) {
      throw new Error(`orca worker ${dispatchId} returned no worktree path for new-child placement; stopped it without verifying the original repository`);
    }
    if (r.state !== "ready") {
      if (/agent[ _-]?launch|launch[ _-]?agent/i.test(r.failedStage ?? "")) {
        launchBroken = `orca agent launch failed: ${r.lastError ?? "no error given"}`;
      }
      m = {
        code: 1, timedOut: false, settled: true,
        summary: `orca worker failed to start at ${r.failedStage ?? r.stage ?? "an unknown stage"}: ${r.lastError ?? "no error given"}`,
      };
    } else {
      before = await repoFingerprint(ctx, worktree ?? task.brief.repo);
      waited = await waitForWorker(ctx, c, {
        taskId: task.id, providerId: cfg.id, prompt, coordinator: p.coordinator, run: p.run, dispatchId, terminal,
        deadlineMs: deps.now() + task.timeoutS * 1000,
        isStopped: () => readTask(ctx, task.id)?.state === "stopped",
        sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log,
      });
      m = mapWait(waited);
    }

    endedAt = deps.now() / 1000;
    tailText = m.tail ?? "";
    if (m.code !== 0 && m.tail === undefined) {
      const rd = await c.workerRead(dispatchId, 60);
      tailText = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
    }
    const keepAlive = task.interactionMode === "conversation" && waited?.kind === "settled" && waited.state === "needs_input";
    if (keepAlive) {
      // An interactive lane's escalation leaves its worker and terminal running, so a live
      // `pacer send`/`pacer answer` can deliver into the same process instead of respawning it.
      log(`keeping orca worker ${dispatchId} alive for a live answer; task is needs_input`);
      finishWorkSync(ctx, admission);
    } else {
      await cleanup(c, dispatchId, terminal, m.settled, log, receipt => { finishOrcaWorkSync(ctx, admission, receipt); });
      await forget();
    }
  } catch (e) {
    try {
      const receipt = await c.workerStop(dispatchId);
      finishOrcaWorkSync(ctx, admission, receipt);
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    await forget();
    throw e;
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
      if (ex.backend !== "orca") return false; // auto means pacer's own supervisor; Orca is opt-in
      return isReady(await new OrcaClient(ctx.run, ctx.env).status());
    },
    runAttempt: (ctx, cfg, task, onSpawn) => runOrcaAttempt(deps, ctx, cfg, task, onSpawn),
  };
}

/** Supervised Orca workers, one worktree per attempt (spec §3.5). */
export const orcaBackend: Backend = makeOrcaBackend();
