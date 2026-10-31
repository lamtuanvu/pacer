import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../core/errors";
import { validateExecution } from "../config/execution";
import type { ProviderCfg, Strategy } from "../config/strategy";
import { readJson, writeJsonAtomic } from "../fsutil";
import { readTask } from "../tasks/store";
import type { TaskRecord } from "../tasks/types";
import type { Ctx } from "../types";
import type { Backend, LiveWorkerOps } from "../exec/backend";
import type { AttemptOutcome } from "../exec/direct";
import { OrcaClient } from "../exec/orca/client";
import { withLock } from "../exec/orca/state";
import type { CallResources } from "./authority";
import { pluginsConfig } from "./config";
import { executorAttemptOutcome, executorOrcaRunDisposition, executorSessionStateResult, executorStopResult } from "./executor-protocol";
import { ORCA_DEFAULTS, ORCA_PROVIDER, OrcaAttemptSession, type OrcaRouteDeps } from "./orca-attempt";
import { liveAgentProblem, releaseLive } from "./orca-host";

export { ORCA_PROVIDER, type OrcaRouteDeps } from "./orca-attempt";

/** The plugin registry surface the Orca route needs; tests substitute an in-process provider. */
export interface OrcaExecutorCaller {
  call(ctx: Ctx, pluginId: string, method: string, params: unknown,
    options: { resources: CallResources; onProgress?: (event: unknown) => void; deadlineMs: number }): Promise<unknown>;
}

const registryCaller: OrcaExecutorCaller = {
  call: async (ctx, pluginId, method, params, options) => (await import("./index")).pluginRegistry(ctx).call(ctx, pluginId, method, params, options),
};
const empty = (): CallResources => ({ reads: [], commands: [], stores: [] });
/** Setup, start, lookups and cleanup are bounded separately; the worker's own wait is bounded by the task timeout. */
const SETUP_BUDGET_MS = 30 * 60 * 1000;

/** The direct route Orca hands over to before any worker exists, with the reason in the attempt log. */
async function fallback(deps: OrcaRouteDeps, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord, onSpawn: ((pid: number) => void) | undefined,
  reason: string, lines: string[] = []): Promise<AttemptOutcome> {
  const out = await deps.direct(ctx, cfg, task, onSpawn);
  if (out.attempt.log) appendFileSync(out.attempt.log, [...lines, `direct backend: Orca fallback (${reason.replace(/\s+/g, " ").trim()})`].join("\n") + "\n");
  try {
    await withLock(ctx, "fallback", async () => {
      const dir = join(ctx.pacerHome, "orca"), path = join(dir, "fallback.json");
      const prior = readJson<{ at: number }>(path);
      if (prior && ctx.now - prior.at < 3600) return;
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "fallback.log"), `${new Date(ctx.now * 1000).toISOString()} orca backend not used: ${reason.replace(/\s+/g, " ").trim()}\n`);
      writeJsonAtomic(path, { at: ctx.now, reason });
    });
  } catch { /* Diagnostics must not prevent direct execution. */ }
  return { ...out, backend: "direct" };
}

/** Run one Orca attempt through the bundled provider; the host keeps fallback, closure and outcome authority. */
async function runOrcaAttempt(deps: OrcaRouteDeps, caller: OrcaExecutorCaller, ctx: Ctx, cfg: ProviderCfg, task: TaskRecord,
  onSpawn?: (pid: number) => void): Promise<AttemptOutcome> {
  let ex;
  try { ex = deps.loadExecution(ctx); }
  catch (e) { return fallback(deps, ctx, cfg, task, onSpawn, (e as Error).message); }
  // A work grant is a secret: it cannot go in a visible Orca terminal command, so delegating work runs directly.
  if (ctx.env.PACER_WORK_GRANT) return fallback(deps, ctx, cfg, task, onSpawn, "the task allows delegation, and its work grant cannot be placed in a visible Orca terminal command");
  const session = new OrcaAttemptSession(ctx, cfg, task, deps, ex);
  try {
    let raw: unknown;
    try {
      raw = await caller.call(ctx, ORCA_PROVIDER, "executor.run", {
        task: { id: task.id, rev: readTask(ctx, task.id)?.rev ?? task.rev }, attempt: session.attempt, runDir: 1,
        orca: { executor: cfg.id, model: cfg.model ?? null, timeoutMs: Math.max(1, Math.min(Math.ceil(task.timeoutS * 1000), 30 * 60 * 1000)),
          ...(task.interactionMode === "conversation" ? { session: "interactive" as const } : {}) },
      }, { resources: { ...empty(), orcaAttempt: { taskId: task.id, attempt: session.attempt, providerId: ORCA_PROVIDER,
        executor: cfg.id, session: session.id } }, onProgress: () => {}, deadlineMs: task.timeoutS * 1000 + SETUP_BUDGET_MS });
    } catch (error) {
      const rescued = await session.rescue(error);
      if ("outcome" in rescued) return rescued.outcome;
      return fallback(deps, ctx, cfg, task, onSpawn, rescued.fallback, session.lines);
    }
    const disposition = executorOrcaRunDisposition.safeParse(raw);
    const choice = disposition.success ? disposition.data.orca : undefined;
    // A refusal must be the host's own; a fallback needs a host-recorded reason or effects the host can abandon.
    const accepted = !!choice && ("refused" in choice ? session.hostRefused && session.phase === "fallback"
      : session.preStart && session.phase !== "new" && session.phase !== "checked");
    if (choice && accepted) {
      if ("refused" in choice) {
        const at = Date.now() / 1000, reason = choice.refused.reason;
        return { exec: { code: 1, stdout: "", stderr: reason, timedOut: false }, report: reason, backend: "orca",
          attempt: { executor: cfg.id, model: cfg.model, startedAt: at, endedAt: at, exitCode: 1, timedOut: false, limitHit: false, log: "" } };
      }
      if (session.phase !== "fallback") {
        const { reason } = await session.abandon(choice.fallback.reason);
        return fallback(deps, ctx, cfg, task, onSpawn, reason, session.lines);
      }
      return fallback(deps, ctx, cfg, task, onSpawn, choice.fallback.reason, session.lines);
    }
    const outcome = executorAttemptOutcome.safeParse(raw);
    if (!disposition.success && outcome.success && session.phase === "done" && session.outcome &&
      JSON.stringify(outcome.data) === JSON.stringify(executorAttemptOutcome.parse(session.outcome)))
      return session.outcome;
    // A direct route after a possible start, or an outcome the host did not record, settles by phase and fails.
    const refusal = new CoreError("conflict", disposition.success ? "Orca provider chose a direct route the host did not issue"
      : "Orca provider outcome is not the host-recorded attempt outcome");
    const rescued = await session.rescue(refusal);
    if ("fallback" in rescued) return fallback(deps, ctx, cfg, task, onSpawn, rescued.fallback, session.lines);
    throw refusal;
  } finally { session.close(); }
}

/** Live-worker effects outside an attempt; the provider's executor.stop owns closure of the exact recorded worker. */
function liveOps(caller: OrcaExecutorCaller): LiveWorkerOps {
  return {
    send: async (ctx, task, text) => {
      if (!task.live || task.live.backend !== "orca") return { ok: false, code: "unavailable", message: "this task has no live terminal to send into" };
      const c = new OrcaClient(ctx.run, ctx.env);
      const problem = await liveAgentProblem(c, task.live);
      if (problem) return { ok: false, code: "unavailable", message: `refused: ${problem}. Nothing was typed; answer or retry the task instead` };
      const sent = await c.terminalSend(task.live.terminal, text);
      return sent.ok ? { ok: true } : { ok: false, code: "unavailable", message: `orca terminal send failed: ${sent.error.code} ${sent.error.message}` };
    },
    release: async (ctx, task, why) => {
      const live = readTask(ctx, task.id)?.live ?? task.live;
      if (!live || live.backend !== "orca") return;
      const attempt = Math.max(1, (readTask(ctx, task.id)?.attempts.length ?? task.attempts.length));
      // Closure stays host authority (ADR 0018): a disabled provider never leaves a live agent behind.
      if (pluginsConfig(ctx).disabled.includes(ORCA_PROVIDER)) {
        await releaseLive(ctx, new OrcaClient(ctx.run, ctx.env), readTask(ctx, task.id) ?? task, why);
        return;
      }
      const raw = await caller.call(ctx, ORCA_PROVIDER, "executor.stop", { taskId: task.id, attempt, graceMs: 0 }, {
        resources: { ...empty(), orcaLive: { taskId: task.id, attempt, providerId: ORCA_PROVIDER, worker: live.worker,
          terminal: live.terminal, ...(live.incarnation ? { incarnation: live.incarnation } : {}), action: "stop", why } },
        deadlineMs: 120_000 });
      if (!executorStopResult.safeParse(raw).success) throw new CoreError("plugin_refused", "Orca provider returned an invalid stop result");
    },
  };
}

/** Read-only state of the task's recorded live worker through the provider. */
export async function orcaLiveSessionState(ctx: Ctx, task: TaskRecord, caller: OrcaExecutorCaller = registryCaller) {
  const live = task.live;
  if (!live || live.backend !== "orca") throw new CoreError("capability_denied", "task has no recorded Orca live worker");
  const attempt = Math.max(1, task.attempts.length);
  const raw = await caller.call(ctx, ORCA_PROVIDER, "executor.sessionState", { taskId: task.id, attempt }, {
    resources: { ...empty(), orcaLive: { taskId: task.id, attempt, providerId: ORCA_PROVIDER, worker: live.worker,
      terminal: live.terminal, ...(live.incarnation ? { incarnation: live.incarnation } : {}), action: "inspect" } },
    deadlineMs: 60_000 });
  const parsed = executorSessionStateResult.safeParse(raw);
  if (!parsed.success || parsed.data.host !== "orca" || parsed.data.handle !== live.terminal)
    throw new CoreError("plugin_refused", "Orca provider returned an invalid session state");
  return parsed.data;
}

/** Whether Orca is selected for this strategy and the provider reports it ready. */
async function orcaAvailable(caller: OrcaExecutorCaller, ctx: Ctx, s: Strategy): Promise<boolean> {
  const ex = validateExecution(s.execution);
  if (ex.backend !== "orca" && ctx.env.PACER_BACKEND !== "orca") return false;
  const raw = await caller.call(ctx, ORCA_PROVIDER, "executor.available", { strategy: { name: "default" } },
    { resources: empty(), deadlineMs: 20_000 }) as { available?: unknown };
  return raw?.available === true;
}

/** The Orca backend: routing stays in the host; the bundled pacer-exec-orca provider drives each attempt. */
export function makeOrcaBackend(over: Partial<OrcaRouteDeps> = {}, caller: OrcaExecutorCaller = registryCaller): Backend {
  // Resolved on use: the default backend list is built while the execution modules are still loading.
  const deps = (): OrcaRouteDeps => ({ ...ORCA_DEFAULTS, ...over });
  return {
    id: "orca",
    available: (ctx, s) => orcaAvailable(caller, ctx, s),
    runAttempt: (ctx, cfg, task, onSpawn) => runOrcaAttempt(deps(), caller, ctx, cfg, task, onSpawn),
    live: liveOps(caller),
  };
}

/** Supervised Orca workers, one worktree per attempt (spec §3.5). */
export const orcaBackend: Backend = makeOrcaBackend();
