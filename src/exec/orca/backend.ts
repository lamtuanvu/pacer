import { beginWorkSync, bindOrcaWorkSync, finishOrcaWorkSync, finishWorkSync } from "../../update/desktop/admission";
import { resolveWorktreeBase } from "../../supervisor/worktree";
import { pidAlive } from "../../link/store";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { shellCommand } from "../../install/fsx";
import { launchArgvFor, providerEnv } from "../launch";
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
import { OrcaClient, type Placement, isReady } from "./client";
import { trustClaudeWorktree } from "../claude-trust";
import { ensureCoordinator, ensureRepo, gitInfo, realpathSafe } from "./setup";
import { updateOrcaState, withLock } from "./state";
import { type WaitResult, waitForWorker } from "./wait";

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
  const placement: Placement = task.retryOf && task.worktree
    ? { kind: "existing", selector: `path:${task.worktree}` }
    : resolved.mode !== "current"
    ? { kind: "new-child", repoId, baseBranch: resolvedBase.sha ?? base, name: `pacer-${task.id}-${cfg.id}` }
    : { kind: "existing", selector: `path:${git.top}` };
  return {
    ok: true, agent: mapped.agent, model: mapped.model, coordinator: coord.coordinator, run: coord.run,
    placement, top: git.top, base, sub: git.sub, notes, resolved,
  };
}

function workerSpec(task: TaskRecord, p: Ready): string {
  const where = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
    : `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}` +
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
  deps: OrcaBackendDeps, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn: ((pid: number) => void) | undefined, reason: string,
): Promise<AttemptOutcome> {
  const out = await deps.direct(ctx, cfg, task, onSpawn);
  if (out.attempt.log) appendFileSync(out.attempt.log, `direct backend: Orca fallback (${reason.replace(/\s+/g, " ").trim()})\n`);
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

async function closeCreatedTerminal(c: OrcaClient, terminal: string): Promise<{failure: string | null; proof: boolean}> {
  let failure = "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const closed = await c.terminalClose(terminal);
      if (closed.ok) {
        const receipt = closed.result.close as {handle?: string; ptyKilled?: boolean} | undefined;
        if (receipt?.handle === terminal && receipt.ptyKilled === true) return {failure: null, proof: true};
        failure = "close receipt lacks exact handle and ptyKilled proof";
        continue;
      }
      failure = `${closed.error.code}: ${closed.error.message}`;
    } catch (e) { failure = String(e instanceof Error ? e.message : e); }
  }
  return {failure, proof: false};
}

async function cleanup(c: OrcaClient, dispatchId: string, terminal: string | null, settled: boolean, log: (l: string) => void, receipt: (reply: Awaited<ReturnType<OrcaClient["workerStop"]>>) => void): Promise<boolean> {
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
    const closed = await closeCreatedTerminal(c, terminal);
    log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
    return closed.proof;
  }
  return false;
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
  let terminal: string | null = null;
  let worktree: string | null = null;
  let selector: string;
  try {
    const placement = p.placement.kind === "new-child"
      ? await c.worktreeCreate(p.placement)
      : await c.worktreeShow(realpathSafe(p.placement.selector.slice("path:".length)));
    if (!placement.ok) throw Error(`orca worktree ${p.placement.kind === "new-child" ? "create" : "show"} failed: ${placement.error.code} ${placement.error.message}`);
    const id = placement.result.worktree?.id;
    if (!id) throw Error("orca worktree returned no id");
    selector = `id:${id}`;
    const root = placement.result.worktree?.path ?? id.slice(id.indexOf("::") + 2);
    if (p.placement.kind === "new-child") {
      const initial = placement.result.terminal?.handle ?? placement.result.initialTerminalHandle ?? placement.result.terminalHandle;
      if (initial) {
        terminal = initial;
        bindOrcaWorkSync(ctx, admission, {dispatchId: "pending", terminal: initial,
          ...(placement.result.terminal?.incarnationId ? {incarnationId: placement.result.terminal.incarnationId} : {})});
        const closed = await closeCreatedTerminal(c, initial);
        if (closed.failure || !closed.proof) throw Error(`orca worktree initial terminal ${initial} could not be verified closed: ${closed.failure ?? "no close receipt"}`);
        terminal = null;
      }
    }
    worktree = p.placement.kind === "existing" ? (task.retryOf && task.worktree ? task.worktree : task.brief.repo)
      : p.sub ? join(root, p.sub) : root;
    if (p.agent === "claude") {
      const env = await providerEnv(ctx, cfg);
      trustClaudeWorktree(ctx, realpathSafe(root), env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(ctx.home, ".claude.json"), task.id);
    }
    const accountEnv = await providerEnv(ctx, cfg);
    if (Object.keys(accountEnv).some(key => key !== "CLAUDE_CONFIG_DIR" && key !== "CODEX_HOME")) {
      throw Error("account environment contains values that cannot be placed in a visible Orca terminal command");
    }
    const command = shellCommand(["env", "PACER_ROLE=executor", `PACER_TASK_ID=${task.id}`,
      ...Object.entries(accountEnv).map(([key, value]) => `${key}=${value}`),
      ...launchArgvFor(cfg, root, tasksDir(ctx), p.top)]);
    const created = await c.terminalCreate(selector, `pacer ${task.id}`, command);
    if (!created.ok || !created.result.terminal?.handle) throw Error(`orca terminal create failed: ${created.ok ? "no handle" : `${created.error.code} ${created.error.message}`}`);
    terminal = created.result.terminal.handle;
    bindOrcaWorkSync(ctx, admission, {dispatchId: "pending", terminal, ...(created.result.terminal.incarnationId ? {incarnationId: created.result.terminal.incarnationId} : {})});
    const idle = await c.terminalWait(terminal);
    if (!idle.ok || idle.result.wait?.satisfied !== true) {
      throw Error(`orca terminal did not become idle: ${idle.ok ? idle.result.wait?.blockedReason ?? idle.result.wait?.status ?? "timeout" : `${idle.error.code} ${idle.error.message}`}`);
    }
  } catch (e) {
    let reason = String(e instanceof Error ? e.message : e);
    let closed = !terminal;
    if (terminal) {
      const result = await closeCreatedTerminal(c, terminal);
      closed = result.proof;
      if (result.failure) reason += `; terminal close failed ${terminal}: ${result.failure}`;
    }
    if (closed) finishWorkSync(ctx, admission);
    return fallback(deps, ctx, cfg, task, onSpawn, reason);
  }
  try {
    ws = await c.workerStart({ spec: prompt, terminal: terminal!, worktree: selector!, run: p.run, from: p.coordinator });
  } catch (e) {
    return uncertainStart(String(e instanceof Error ? e.message : e));
  }
  if (!ws.ok && ["timeout", "bad_output"].includes(ws.error.code)) {
    return uncertainStart(`${ws.error.code}: ${ws.error.message}`);
  }
  if (!ws.ok) {
    if (ws.error.code !== "task_not_startable") return uncertainStart(`${ws.error.code}: ${ws.error.message}`);
    const closed = await closeCreatedTerminal(c, terminal!);
    if (closed.proof) finishWorkSync(ctx, admission);
    return fallback(deps, ctx, cfg, task, onSpawn, `orca worker-start refused (${ws.error.code}: ${ws.error.message})`
      + (closed.failure ? `; terminal close failed ${terminal}: ${closed.failure}` : ""));
  }
  startedAt = deps.now() / 1000;
  const r = ws.result;
  if (!r.dispatchId) return uncertainStart("orca worker-start returned no dispatch id");
  const dispatchId = r.dispatchId;
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
      m = mapWait(await waitForWorker(ctx, c, {
        taskId: task.id, providerId: cfg.id, prompt, coordinator: p.coordinator, run: p.run, dispatchId, terminal,
        deadlineMs: deps.now() + task.timeoutS * 1000,
        isStopped: () => readTask(ctx, task.id)?.state === "stopped",
        sliceMs: deps.sliceMs, now: deps.now, sleep: deps.sleep, log,
      }));
    }

    endedAt = deps.now() / 1000;
    tailText = m.tail ?? "";
    if (m.code !== 0 && m.tail === undefined) {
      const rd = await c.workerRead(dispatchId, 60);
      tailText = rd.ok ? (rd.result.terminal?.tail ?? []).join("\n") : "";
    }
    const closed = await cleanup(c, dispatchId, terminal, m.settled, log, receipt => { finishOrcaWorkSync(ctx, admission, receipt); });
    if (closed) finishWorkSync(ctx, admission);
    await forget();
  } catch (e) {
    try {
      const receipt = await c.workerStop(dispatchId);
      finishOrcaWorkSync(ctx, admission, receipt);
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    if (terminal) {
      const closed = await closeCreatedTerminal(c, terminal);
      log(`closed pacer terminal ${terminal}: ${closed.failure ?? "ok"}`);
      if (closed.proof) finishWorkSync(ctx, admission);
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
      if (ex.backend !== "orca" && ctx.env.PACER_BACKEND !== "orca") return false;
      return isReady(await new OrcaClient(ctx.run, ctx.env).status());
    },
    runAttempt: (ctx, cfg, task, onSpawn) => runOrcaAttempt(deps, ctx, cfg, task, onSpawn),
  };
}

/** Supervised Orca workers, one worktree per attempt (spec §3.5). */
export const orcaBackend: Backend = makeOrcaBackend();
