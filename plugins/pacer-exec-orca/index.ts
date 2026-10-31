import { PluginError, serve, type Handler, type HostClient } from "@pacer/plugin";
import { z } from "zod";
import { manifest } from "./manifest";
export { manifest } from "./manifest";

const runInput = z.object({
  task: z.object({ id: z.string(), rev: z.number().int().positive() }).strict(),
  attempt: z.number().int().positive(), runDir: z.literal(1),
  orca: z.object({ executor: z.string().min(1).max(256), model: z.string().max(256).nullable(),
    timeoutMs: z.number().int().positive().max(30 * 60 * 1000), session: z.literal("interactive").optional() }).strict(),
}).strict();
const owner = z.object({ taskId: z.string(), attempt: z.number().int().positive() });

export type WaitResult =
  | { kind: "done"; outcome: string; subject: string; body: string }
  | { kind: "settled"; state: string; error: string | null; tail?: string; needsStop?: boolean }
  | { kind: "timeout" }
  | { kind: "stopped" };
export interface Mapped { code: number; timedOut: boolean; settled: boolean; summary: string; tail?: string }
interface Started { kind: "started"; dispatchId: string; state: string | null; stage: string | null; failedStage: string | null; lastError: string | null }

/** The attempt outcome a supervised wait means; only a settled worker is released rather than stopped. */
export function mapWait(w: WaitResult): Mapped {
  switch (w.kind) {
    case "done":
      return {
        code: w.outcome === "succeeded" ? 0 : 1, timedOut: false, settled: true,
        summary: [w.subject, w.body].filter((x) => x.trim()).join("\n\n") || `worker_done: ${w.outcome}`,
      };
    case "settled":
      return {
        code: w.state === "succeeded" ? 0 : 1, timedOut: false, settled: !w.needsStop, ...(w.tail === undefined ? {} : { tail: w.tail }),
        summary: `orca worker ${w.state} without a worker_done report${w.error ? ` (${w.error})` : ""}`,
      };
    case "timeout":
      return { code: 1, timedOut: true, settled: false, summary: "orca worker timed out at the task timeout; stopped it" };
    case "stopped":
      return { code: 1, timedOut: false, settled: false, summary: "stopped by the planner; stopped the orca worker" };
  }
}

/** A worker that did not start ready; an agent-launch failure marks the attempt broken. */
export function mapFailedStart(start: Started): { mapped: Mapped; launchBroken?: string } {
  const launchBroken = /agent[ _-]?launch|launch[ _-]?agent/i.test(start.failedStage ?? "")
    ? `orca agent launch failed: ${start.lastError ?? "no error given"}` : undefined;
  return { mapped: { code: 1, timedOut: false, settled: true,
    summary: `orca worker failed to start at ${start.failedStage ?? start.stage ?? "an unknown stage"}: ${start.lastError ?? "no error given"}` },
  ...(launchBroken ? { launchBroken } : {}) };
}

/**
 * The #461 terminal-worker attempt, sequenced over host-issued Orca effects. Fallback is chosen only before a
 * worker can exist; an uncertain start is looked up a bounded number of times and never retried or replaced.
 */
async function runOrca(params: z.infer<typeof runInput>, host: HostClient, signal: AbortSignal,
  sleep: (ms: number) => Promise<void>): Promise<unknown> {
  const ids = { taskId: params.task.id, attempt: params.attempt };
  const call = <T>(method: string, extra: Record<string, unknown> = {}): Promise<T> => {
    if (signal.aborted) throw new PluginError("plugin_unavailable", "Orca attempt was cancelled; the host settles its effects");
    return host.call<T>(method, { ...ids, ...extra });
  };
  const fallback = (reason: string) => ({ orca: { fallback: { reason } } });
  const abandon = async (reason: string) =>
    fallback((await call<{ reason: string }>("capability.orca.abandon", { reason })).reason);

  const live = await call<{ kind: "none" } | { kind: "fallback"; reason: string } | { kind: "attached"; dispatchId: string }>("capability.orca.liveAnswer");
  if (live.kind === "fallback") return fallback(live.reason);
  if (live.kind === "attached") return supervise(call, true, null);

  const prepared = await call<{ ok: true } | { ok: false; reason: string; refuse: boolean }>("capability.orca.prepare");
  if (!prepared.ok) return prepared.refuse ? { orca: { refused: { reason: prepared.reason } } } : fallback(prepared.reason);
  const placed = await call<{ ok: true } | { ok: false; reason: string }>("capability.orca.place");
  if (!placed.ok) return abandon(placed.reason);
  const terminal = await call<{ ok: true } | { ok: false; reason: string }>("capability.orca.terminal");
  if (!terminal.ok) return abandon(terminal.reason);

  const start = await call<Started | { kind: "refused"; code: string; message: string } | { kind: "uncertain"; reason: string }>("capability.orca.start");
  if (start.kind === "refused") return abandon(`orca worker-start refused (${start.code}: ${start.message})`);
  let started: Started;
  if (start.kind === "uncertain") {
    let found: { kind: "found" | "none" | "unknown" } = { kind: "unknown" };
    for (let i = 0; i < 3; i++) {
      if (i) await sleep(5_000);
      found = await call("capability.orca.lookup");
      if (found.kind === "found") break;
    }
    if (found.kind !== "found") return call("capability.orca.unstarted");
    started = await call<Started>("capability.orca.adopt");
  } else started = start;
  return supervise(call, params.orca.session === "interactive", started);
}

async function supervise(call: <T>(method: string, extra?: Record<string, unknown>) => Promise<T>,
  interactive: boolean, started: Started | null): Promise<unknown> {
  let mapped: Mapped, launchBroken: string | undefined, keepAlive = false;
  if (started && started.state !== "ready") ({ mapped, launchBroken } = mapFailedStart(started));
  else {
    const waited = await call<WaitResult>("capability.orca.wait");
    mapped = mapWait(waited);
    // An interactive lane's escalation keeps its worker and terminal for a live answer; the host confirms the owner.
    keepAlive = interactive && waited.kind === "settled" && waited.state === "needs_input";
  }
  if (!keepAlive) await call("capability.orca.settle", { settled: mapped.settled });
  return call("capability.orca.finish", { ...mapped, keepAlive, ...(launchBroken ? { launchBroken } : {}) });
}

/** Handlers with an injectable clock for host tests; production serves the defaults. */
export function createHandlers(options: { sleep?: (ms: number) => Promise<void> } = {}): Record<string, Handler> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  return {
    "executor.available": async (_params, host, signal) => {
      if (signal.aborted) throw new PluginError("plugin_unavailable", "availability check was cancelled");
      const status = await host.call<{ ready: boolean; reason?: string }>("capability.orca.status", {});
      return status.ready ? { available: true } : { available: false, reason: status.reason ?? "the Orca runtime is not ready" };
    },
    "executor.run": async (params, host, signal) => {
      const parsed = runInput.safeParse(params);
      if (!parsed.success) throw new PluginError("invalid_input", "an Orca terminal-worker attempt is required");
      return runOrca(parsed.data, host, signal, sleep);
    },
    "executor.stop": async (params, host, signal) => {
      const stop = owner.extend({ graceMs: z.number().int().nonnegative().max(25_000) }).strict().parse(params);
      if (signal.aborted) throw new PluginError("plugin_unavailable", "executor stop was cancelled");
      return host.call<{ code: number; killed: boolean }>("capability.orca.stop", { taskId: stop.taskId, attempt: stop.attempt });
    },
    "executor.sessionState": async (params, host, signal) => {
      const input = owner.strict().parse(params);
      if (signal.aborted) throw new PluginError("plugin_unavailable", "executor inspection was cancelled");
      const observed = await host.call<{ state: "running" | "exited" | "uncertain"; handle: string | null }>("capability.orca.sessionState", input);
      return { state: observed.state, host: "orca", handle: observed.handle };
    },
  };
}

export const handlers = createHandlers();

if (import.meta.main) await serve({ manifest, handlers });
