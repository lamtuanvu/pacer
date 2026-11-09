/**
 * Runs `pacer serve` from source (the same `main(["serve", ...])` path as `bun src/cli.ts serve`)
 * with instrumentation for scripts/perf/run.ts:
 *
 * - an event-loop lag sampler on the service's main thread;
 * - process CPU samples (all threads of this process, including the supervision worker);
 * - PERF_SUPERVISION=inprocess forces the service's in-process supervision fallback by making
 *   only the supervision worker's constructor throw, which startServer already handles.
 *
 * Stats are written to PERF_STATS_FILE every second and on SIGTERM/SIGINT.
 * Never run this against a real home: run.ts creates the temp PACER_HOME and HOME it needs.
 */
import { renameSync, writeFileSync } from "node:fs";

const statsFile = process.env.PERF_STATS_FILE;
const port = process.env.PERF_PORT;
const mode = process.env.PERF_SUPERVISION === "inprocess" ? "inprocess" : "worker";
if (!statsFile || !port) throw new Error("serve-child: PERF_STATS_FILE and PERF_PORT are required");

if (mode === "inprocess") {
  const RealWorker = globalThis.Worker;
  globalThis.Worker = new Proxy(RealWorker, {
    construct(target, args: ConstructorParameters<typeof Worker>) {
      if (String(args[0]).includes("supervision-worker")) throw new Error("perf: supervision worker disabled (PERF_SUPERVISION=inprocess)");
      return Reflect.construct(target, args);
    },
  });
}

const LAG_INTERVAL_MS = 50;
const startedAt = Date.now();
// [epoch ms, lag ms] for every sampler tick, and [epoch ms, user µs, system µs] once a second.
const lag: [number, number][] = [];
const cpu: [number, number, number][] = [];
let expected = performance.now() + LAG_INTERVAL_MS;
const lagTimer = setInterval(() => {
  const now = performance.now();
  lag.push([Date.now(), Math.max(0, Math.round(now - expected))]);
  expected = now + LAG_INTERVAL_MS;
}, LAG_INTERVAL_MS);
const sampleCpu = () => { const u = process.cpuUsage(); cpu.push([Date.now(), u.user, u.system]); };
sampleCpu();
const cpuTimer = setInterval(sampleCpu, 1000);

// A main loop that is blocked at shutdown never runs the SIGTERM flush; the runner then treats the
// time since `flushedAt` as a stall still in progress, so flush often.
const flush = (final = false) => {
  sampleCpu();
  const tmp = `${statsFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, mode, startedAt, flushedAt: Date.now(), final, lagIntervalMs: LAG_INTERVAL_MS, lag, cpu }));
  renameSync(tmp, statsFile);
};
const flushTimer = setInterval(() => flush(), 1000);

let stopping = false;
const finish = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(lagTimer);
  clearInterval(cpuTimer);
  clearInterval(flushTimer);
  try { flush(true); } finally { process.exit(0); }
};
process.on("SIGTERM", finish);
process.on("SIGINT", finish);

const { main } = await import("../../src/cli");
const r = await main(["serve", "--port", port]);
if (r.out) console.log(r.out);
if (r.err) console.error(r.err);
if (r.code !== 0 || !r.keepAlive) {
  flush();
  process.exit(r.code || 1);
}
console.error(`perf: serving on ${port} supervision=${mode} pid=${process.pid}`);
