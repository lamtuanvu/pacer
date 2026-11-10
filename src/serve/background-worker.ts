import { makeCtx } from "../ctx";
import type { Ctx } from "../types";
import { pumpOnce, defaultPumpDeps } from "../link/pump";
import { brokerTick } from "../messaging/broker";
import { autoCleanSweep } from "../core/tasks";
import { tick as certificationTick } from "../dispatch/certification-schedule";
import { refreshAllUsage } from "../usage/refresh";
import { refreshObservations } from "../dispatch/refresh";
import { setOutboxCrossPost } from "../link/store";

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
 * request, while pumpOnce computes its own status through defaultPumpDeps.
 */
interface WorkerInit {
  type: "init";
  pacerHome: string;
  env: Record<string, string>;
  /** The service's selfCommand(); the worker's own argv names the worker module. */
  selfCommand: string[];
  /** Link pump cadence; <= 0 disables the periodic pump loop. */
  pumpMs: number;
}

type LoopName = "pump" | "broker" | "sweep" | "certification" | "usage" | "observations";
const MANAGED_LOOPS: LoopName[] = ["pump", "broker", "sweep", "certification", "usage", "observations"];

let stopped = false;
let init: { env: Record<string, string>; pacerHome: string } | null = null;
let pumpMs = 0;
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

// Heartbeat independent of any loop so a parent can detect a hung worker and restart it.
timers.push(setInterval(() => report({ type: "heartbeat" }), 5000));

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
  // The pump cadence is configurable (pumpMs); 0 means the host serves without a periodic pump.
  if (pumpMs > 0) loop("pump", pumpMs, 250, c => pumpOnce(c, defaultPumpDeps));
  loop("broker", 15_000, 1000, c => brokerTick(c, { spawnRunner: spawnRunner ?? undefined, mode: statusMode }));
  loop("sweep", 60 * 60_000, 500, c => autoCleanSweep(c));
  loop("certification", 10 * 60_000, 2000, c => certificationTick(c));
  loop("usage", 15 * 60_000, 3000, c => refreshAllUsage({ ...c, now: Date.now() / 1000 }, true));
  loop("observations", 60_000, 1000, c => refreshObservations(c));
}

self.onmessage = async (event: MessageEvent<WorkerInit>) => {
  const msg = event.data;
  if (!msg || msg.type !== "init") return;
  try {
    init = { env: msg.env, pacerHome: msg.pacerHome };
    pumpMs = typeof msg.pumpMs === "number" && Number.isFinite(msg.pumpMs) && msg.pumpMs > 0 ? msg.pumpMs : 0;
    if (!Array.isArray(msg.selfCommand) || !msg.selfCommand.length || msg.selfCommand.some(part => typeof part !== "string" || !part))
      throw new Error("missing service self command");
    const { spawnRunnerWith } = await import("../tasks/api");
    spawnRunner = spawnRunnerWith(msg.selfCommand);
  } catch (error) {
    report({ type: "failed", reason: String(error) });
    return;
  }
  report({ type: "heartbeat" });
  runLoops();
};

process.on("exit", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });