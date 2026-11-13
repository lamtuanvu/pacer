import { makeCtx } from "../ctx";
import type { Ctx } from "../types";
import { pumpOnce, defaultPumpDeps } from "../link/pump";
import { brokerTick } from "../messaging/broker";
import { autoCleanSweep } from "../core/tasks";
import { tick as certificationTick } from "../dispatch/certification-schedule";
import { refreshAllUsage } from "../usage/refresh";
import { refreshObservations } from "../dispatch/refresh";
import { setOutboxCrossPost } from "../link/store";
import { HOST_SOCKET_KEY_ENV, takeOwnerKey } from "../plugins/host-bridge";

/**
 * The periodic work loop, owned by pacer serve (spec §5). All background loops
 * (link pump, messaging broker, clean sweep, certification, usage refresh,
 * observations) run in this one Worker with its own SQLite connection, so none of
 * them can stall the request thread. The main thread keeps HTTP, SSE, session
 * WebSockets, snapshot-cache refresh and the /_internal/* bridges.
 *
 * The pattern follows src/tasks/supervision-worker.ts: the parent posts `init`,
 * the worker builds its own context from pacerHome/env and reports heartbeats. It
 * adds `{type:"outbox"}` after any publish so SSE on the parent wakes without
 * polling, and `{type:"loop"}` after each loop so the parent can report health.
 * Status refresh is NOT owned here: `status()` is a synchronous request-path
 * dependency (read-cache warm-up, budget holder) so the parent computes it per
 * request, while pumpOnce computes its own status through defaultPumpDeps. The
 * parent re-runs status after the usage loop reports ok.
 *
 * A `{type:"stop"}` message asks the worker to stop cleanly: it finishes the
 * current loop (releasing file locks), then closes itself. The parent only calls
 * terminate() after a bounded grace period.
 */
interface WorkerInit {
  type: "init";
  pacerHome: string;
  env: Record<string, string>;
  /** The service's selfCommand(); the worker's own argv names the worker module. */
  selfCommand: string[];
  /** Link pump cadence; <= 0 disables the periodic pump and observations loops. */
  pumpMs: number;
  /** Heartbeat cadence; default 5000ms. */
  heartbeatMs?: number;
  /** Usage refresh cadence; default 15 minutes. */
  usageMs?: number;
  /** The plugin owner's credential Core holds; this thread does not share Core's module state. */
  ownerKey?: string;
}

type LoopName = "pump" | "broker" | "sweep" | "certification" | "usage" | "observations";
const MANAGED_LOOPS: LoopName[] = ["pump", "broker", "sweep", "certification", "usage", "observations"];

let stopped = false;
let init: { env: Record<string, string>; pacerHome: string } | null = null;
let pumpMs = 0;
let usageMs = 15 * 60_000;
let spawnRunner: ((ctx: ReturnType<typeof makeCtx>, taskId: string) => number | undefined) | null = null;
const busy = new Set<string>();
const timers: (ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>)[] = [];

/** Init options only: a context captures `now` once, so each loop builds a fresh one. */
function fresh(): ReturnType<typeof makeCtx> {
  return makeCtx(init!);
}

function report(msg: Record<string, unknown>): void {
  if (!stopped) self.postMessage(msg);
}

/** Stop after the current loop finishes so in-flight file locks are released. */
function stopAll(): void {
  if (stopped) return;
  stopped = true;
  for (const t of timers) {
    if (typeof (t as { refresh?: unknown }).refresh === "function") clearInterval(t as ReturnType<typeof setInterval>);
    else clearTimeout(t as ReturnType<typeof setTimeout>);
  }
  timers.length = 0;
  self.postMessage({ type: "stopped" });
  if (busy.size === 0) self.close();
}

// Heartbeat independent of any loop so a parent can detect a hung worker and restart it.
let heartbeatMs = 5000;
function armHeartbeat(): void {
  timers.push(setInterval(() => report({ type: "heartbeat" }), heartbeatMs));
}

// Outbox publishes happen through notifyOutbox (shared with the main thread); bridge
// them to the parent so SSE on the request thread wakes without polling.
setOutboxCrossPost(() => report({ type: "outbox" }));

let firstRunToward = 0;
function loop(name: LoopName, intervalMs: number, firstDelayMs: number, fn: (c: Ctx) => Promise<unknown>): void {
  const run = async () => {
    if (stopped || busy.has(name)) return;
    busy.add(name);
    try {
      await fn(fresh());
      report({ type: "loop", name, ok: true });
    } catch (error) {
      report({ type: "loop", name, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.delete(name);
      firstRunToward = 0;
      if (stopped && busy.size === 0) self.close();
    }
  };
  timers.push(setTimeout(run, firstDelayMs));
  timers.push(setInterval(run, intervalMs));
}

const statusMode = async () => {
  try { return (await defaultPumpDeps.status(fresh())).mode; }
  catch { return undefined; }
};

function runLoops(): void {
  if (!init) return;
  report({ type: "loops", names: MANAGED_LOOPS });
  // Poll changes/active tasks at 500ms; pumpOnce keeps status/entity/quota work at 15s.
  // A shorter pumpMs remains useful for tests; 0 disables both paths.
  if (pumpMs > 0) loop("pump", Math.min(pumpMs, 500), 250, c => pumpOnce(c, defaultPumpDeps, { poll: true }));
  loop("broker", 15_000, 1000, c => brokerTick(c, { spawnRunner: spawnRunner ?? undefined, mode: statusMode }));
  loop("sweep", 60 * 60_000, 500, c => autoCleanSweep(c));
  loop("certification", 10 * 60_000, 2000, c => certificationTick(c));
  loop("usage", usageMs, 3000, c => refreshAllUsage({ ...c, now: Date.now() / 1000 }, true));
  // Observations follow the pump cadence, as before the worker (spec §5 draft): no
  // periodic pump means no observations loop either.
  if (pumpMs > 0) loop("observations", 60_000, 1000, c => refreshObservations(c));
}

type WorkerMessage = WorkerInit | { type: "stop" };

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "stop") { stopAll(); return; }
  if (msg.type !== "init") return;
  try {
    init = { env: msg.env, pacerHome: msg.pacerHome };
    if (typeof msg.ownerKey === "string") takeOwnerKey({ [HOST_SOCKET_KEY_ENV]: msg.ownerKey });
    pumpMs = typeof msg.pumpMs === "number" && Number.isFinite(msg.pumpMs) && msg.pumpMs > 0 ? msg.pumpMs : 0;
    heartbeatMs = typeof msg.heartbeatMs === "number" && Number.isFinite(msg.heartbeatMs) && msg.heartbeatMs > 0 ? msg.heartbeatMs : 5000;
    usageMs = typeof msg.usageMs === "number" && Number.isFinite(msg.usageMs) && msg.usageMs > 0 ? msg.usageMs : 15 * 60_000;
    if (!Array.isArray(msg.selfCommand) || !msg.selfCommand.length || msg.selfCommand.some(part => typeof part !== "string" || !part))
      throw new Error("missing service self command");
    const { spawnRunnerWith } = await import("../tasks/api");
    spawnRunner = spawnRunnerWith(msg.selfCommand);
  } catch (error) {
    report({ type: "failed", reason: String(error) });
    return;
  }
  report({ type: "heartbeat" });
  armHeartbeat();
  runLoops();
};

process.on("exit", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });