import { pidAlive } from "../../link/store";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../../fsutil";
import { type ExecutionCfg, validateExecution } from "../../config/execution";
import { type ProviderCfg, loadStrategy } from "../../config/strategy";
import { readTask, tasksDir, listTasks, updateTask } from "../../tasks/store";
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
  const pick = orcaAgentFor(cfg, preliminary.mode==="current"?"current":ex.worktree==="current"?"new-child":ex.worktree);
  if ("skip" in pick) return { ok: false, reason: pick.skip };
  if (!isReady(await c.status())) return { ok: false, reason: "the Orca runtime is not ready (orca status)" };
  const git = await gitInfo(ctx.run, task.brief.repo);
  if ("error" in git) return { ok: false, reason: git.error };
  const active=listTasks(ctx,Infinity).some(t=>{
    if(t.id===task.id||t.state!=="running"||!t.runnerPid||!pidAlive(t.runnerPid))return false;
    const path=realpathSafe(t.worktree??t.result?.worktree??t.brief.repo), top=realpathSafe(git.top);
    return path===top||path.startsWith(top+"/");
  });
  if(active&&task.placement?.requested==="current")return {ok:false,reason:"another pacer task is running in the current worktree; requested current placement refused",refuse:true};
  const resolved=resolvePlacement(task,ex.worktree,active,git.dirty);
  if(resolved.mode==="current"&&resolved.why==="strategy default"&&git.dirty)return {ok:false,reason:"current worktree has uncommitted changes",refuse:true};
  const mapped=orcaAgentFor(cfg,resolved.mode==="current"?"current":"new-child");
  if("skip" in mapped)return {ok:false,reason:mapped.skip};
  const base = ex.worktree==="child-of-current"?git.branch:ex.baseBranch ?? git.branch;
  if (resolved.mode !== "current" && base === "HEAD") {
    return { ok: false, reason: `${git.top} has a detached HEAD; check out a branch or set execution.base_branch` };
  }
  const repoId = await ensureRepo(c, git.top, {main:git.main,linked:git.linked,registerRepos:ex.registerRepos});
  if (typeof repoId !== "string") return { ok: false, reason: repoId.error };
  const coord = await ensureCoordinator(ctx, c, git.top);
  if ("error" in coord) return { ok: false, reason: coord.error };
  const notes: string[] = [];
  if (resolved.mode !== "current" && git.dirty) {
    notes.push(`note: ${git.top} has uncommitted changes; the worker's new worktree starts from ${base} without them`);
  }
  // New-child worktree names pacer-<taskId>-<providerId> also identify executor hook sessions.
  const placement: Placement = resolved.mode !== "current"
    ? { kind: "new-child", repoId, baseBranch: base, name: `pacer-${task.id}-${cfg.id}` }
    : { kind: "existing", selector: `path:${git.top}` };
  return {
    ok: true, agent: mapped.agent, model: mapped.model, coordinator: coord.coordinator, run: coord.run,
    placement, top: git.top, base, sub: git.sub, notes, resolved,
  };
}

function workerSpec(task: TaskRecord, p: Ready): string {
  if (p.placement.kind === "existing") return buildPrompt(task.brief, task.id);
  const where = `The current working directory: a new Orca worktree of ${p.top} branched from ${p.base}` +
    `${p.sub ? `. Work in its ${p.sub}/ subdirectory` : ""}. Do not edit ${p.top} itself.`;
  return buildPrompt({ ...task.brief, repo: where }, task.id);
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

async function cleanup(c: OrcaClient, dispatchId: string, terminal: string | null, settled: boolean, log: (l: string) => void) {
  let stop = !settled;
  if (settled) {
    const rel = await c.workerRelease(dispatchId);
    log(`worker-release: ${rel.ok ? (rel.result.state ?? "ok") : rel.error.code}`);
    if (!rel.ok && rel.error.code === "dispatch_inactive") stop = true;
  }
  if (stop) {
    const st = await c.workerStop(dispatchId);
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

  updateTask(ctx,task.id,t=>{t.baseBranch=p.base;t.placement={requested:task.placement?.requested??"auto",...task.placement,...p.resolved};delete t.worktree;});
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
  try {
    ws = await c.workerStart({ spec: prompt, agent: p.agent, model: p.model, placement: p.placement, run: p.run, from: p.coordinator });
  } catch (e) {
    return uncertainStart(String(e instanceof Error ? e.message : e));
  }
  if (!ws.ok && ["timeout", "bad_output"].includes(ws.error.code)) {
    return uncertainStart(`${ws.error.code}: ${ws.error.message}`);
  }
  if (!ws.ok) return fallback(deps, ctx, cfg, task, onSpawn, `orca worker-start refused (${ws.error.code}: ${ws.error.message})`);
  startedAt = deps.now() / 1000;
  const r = ws.result;
  if (!r.dispatchId) return uncertainStart("orca worker-start returned no dispatch id");
  const dispatchId = r.dispatchId;
  const root = worktreePathOf(r.effects);
  const worktree = p.placement.kind === "existing" ? task.brief.repo : root ? (p.sub ? join(root, p.sub) : root) : null;
  if(worktree)updateTask(ctx,task.id,t=>{t.worktree=worktree;});
  const terminal = agentTerminalOf(r.effects);
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
        providerId: cfg.id, prompt, coordinator: p.coordinator, run: p.run, dispatchId, terminal,
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
    await cleanup(c, dispatchId, terminal, m.settled, log);
    await forget();
  } catch (e) {
    try {
      await c.workerStop(dispatchId);
    } catch (stopError) {
      log(`worker-stop failed: ${String(stopError)}`);
    }
    await forget();
    throw e;
  }

  const exec: ExecResult = { code: m.code, stdout: m.summary, stderr: tailText, timedOut: m.timedOut };
  const after = await repoFingerprint(ctx, worktree ?? task.brief.repo);
  const reason = launchBroken ?? brokenReason(exec, endedAt - startedAt, before === null && after === null ? null : before !== null && before === after);
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
      exitCode: m.code, timedOut: m.timedOut, limitHit: detectLimit(cfg.id, exec), log: logFile,
    },
  };
}

export function makeOrcaBackend(over: Partial<OrcaBackendDeps> = {}): Backend {
  const deps: OrcaBackendDeps = { ...DEFAULTS, ...over };
  return {
    id: "orca",
    available: async (ctx, s) => {
      const ex = validateExecution(s.execution);
      if (ex.backend === "direct") return false;
      return isReady(await new OrcaClient(ctx.run, ctx.env).status());
    },
    runAttempt: (ctx, cfg, task, onSpawn) => runOrcaAttempt(deps, ctx, cfg, task, onSpawn),
  };
}

/** Supervised Orca workers, one worktree per attempt (spec §3.5). */
export const orcaBackend: Backend = makeOrcaBackend();
