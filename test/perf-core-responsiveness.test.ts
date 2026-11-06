import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildSyntheticHome } from "../scripts/perf/synthetic-home";
import { execProcess } from "../src/exec/process";
import { startServer } from "../src/serve/http";
import type { Ctx, RunFn } from "../src/types";
import { tmpDir } from "./helpers";

// Regression guard for the core read path; the full benchmark is `bun run perf`.
// Invariant: while nothing changes, main-thread work is proportional to unsettled work, not to
// task history. Settled records are decoded once and again only when their revision changes.
//
// Always enforced (deterministic, independent of machine speed and load):
// - settled task records decoded per idle second; a single pass over the history exceeds it;
// - total JSON decoded per idle second.
// The plan's wall-clock targets (loop lag max < 100 ms, /v3/hello p99 < 50 ms) are measured and
// logged on every run but enforced only with PACER_PERF_WALLCLOCK=1: on a loaded machine an idle
// Bun process alone shows tens of milliseconds of lag.
const SETTLED = Number(process.env.PACER_PERF_TASKS ?? 1_000);
const WALLCLOCK = process.env.PACER_PERF_WALLCLOCK === "1";
const BUDGET = {
  settledDecodesPerSecond: 10,
  idleJsonBytesPerSecond: 1024 * 1024,
  loopLagMaxMs: 100,
  helloP99Ms: 50,
};
const WARMUP_MS = 2_000, WINDOW_MS = 6_000, LAG_INTERVAL_MS = 20, PROBE_INTERVAL_MS = 200;
const RECORD_ID = /"id":"(t-\d{8}-\d{6}-[0-9a-f]{4})"/;

// Only git runs for real; no executor, login shell or other external command is reachable.
const gitOnly: RunFn = (argv, timeoutMs, o) => argv[0] === "git"
  ? execProcess({ argv, cwd: process.cwd(), env: { ...process.env, ...(o?.env ?? {}) }, timeoutMs })
  : Promise.resolve({ code: 127, stdout: "", stderr: "not available in this test" });

test(`core main thread stays idle-cheap with ${SETTLED} settled tasks`, async () => {
  const root = tmpDir();
  const pacerHome = join(root, "pacer"), home = join(root, "home");
  const build = buildSyntheticHome({
    pacerHome, home, repos: [join(root, "repos", "alpha"), join(root, "repos", "beta")],
    settled: SETTLED, unsettled: 10, runDirs: "last", logBytes: 2 * 1024 * 1024,
  });
  const settled = new Set(build.settledIds);
  const ctx: Ctx = {
    home, pacerHome, now: Date.now() / 1000, run: gitOnly, which: () => null,
    env: { HOME: home, PACER_HOME: pacerHome, PACER_NO_UPDATE_CHECK: "1", PACER_BACKEND: "direct", PACER_LOGIN_ENV: "off", PATH: process.env.PATH ?? "/usr/bin:/bin" },
  };

  const realParse = JSON.parse;
  let counting = false, parsedBytes = 0, settledDecodes = 0;
  JSON.parse = function (text: string, reviver?: Parameters<typeof JSON.parse>[1]) {
    if (counting && typeof text === "string") {
      parsedBytes += text.length;
      const id = text.length > 1_000 && text.startsWith("{") ? RECORD_ID.exec(text.slice(0, 200))?.[1] : undefined;
      if (id && settled.has(id)) settledDecodes++;
    }
    return realParse.call(JSON, text, reviver);
  } as typeof JSON.parse;
  const t0 = Date.now();
  const server = startServer(() => ({ ...ctx, now: Date.now() / 1000 }), { port: 0, listener: false, pumpMs: 2_000 });
  const lags: number[] = [], hello: number[] = [];
  try {
    const probe = async () => {
      const started = performance.now();
      const r = await fetch(`http://127.0.0.1:${server.port}/v3/hello`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(30_000) });
      await r.arrayBuffer();
      return { status: r.status, ms: performance.now() - started };
    };
    while ((await probe().catch(() => ({ status: 0, ms: 0 }))).status !== 200) {
      if (Date.now() - t0 > 30_000) throw new Error("service never answered /v3/hello");
      await Bun.sleep(50);
    }
    const readyMs = Date.now() - t0;
    await Bun.sleep(WARMUP_MS);

    let expected = performance.now() + LAG_INTERVAL_MS;
    const sampler = setInterval(() => {
      const now = performance.now();
      lags.push(Math.max(0, now - expected));
      expected = now + LAG_INTERVAL_MS;
    }, LAG_INTERVAL_MS);
    counting = true;
    const windowStart = performance.now();
    const probes: Promise<void>[] = [];
    while (performance.now() - windowStart < WINDOW_MS) {
      probes.push(probe().then(r => { hello.push(r.status === 200 ? r.ms : Infinity); }, () => { hello.push(Infinity); }));
      await Bun.sleep(PROBE_INTERVAL_MS);
    }
    const seconds = (performance.now() - windowStart) / 1000;
    counting = false;
    clearInterval(sampler);
    // A probe still unanswered a second after the window counts as unbounded latency.
    await Promise.race([Promise.all(probes), Bun.sleep(1_000)]);
    while (hello.length < probes.length) hello.push(Infinity);

    const sorted = [...hello].sort((a, b) => a - b);
    const measured = {
      settled: SETTLED, avgRecordBytes: build.avgRecordBytes, buildMs: build.buildMs, readyMs,
      settledDecodesPerSecond: Math.round(settledDecodes / seconds),
      idleJsonBytesPerSecond: Math.round(parsedBytes / seconds),
      loopLagMaxMs: Math.round(Math.max(0, ...lags)),
      helloP99Ms: Math.round(sorted[Math.max(0, Math.ceil(0.99 * sorted.length) - 1)] ?? Infinity),
      helloSamples: hello.length,
    };
    console.log(`perf-core-responsiveness: ${JSON.stringify(measured)}${WALLCLOCK ? "" : " (wall-clock budgets not enforced; set PACER_PERF_WALLCLOCK=1)"}`);
    const violations = [
      measured.settledDecodesPerSecond > BUDGET.settledDecodesPerSecond && `settled task records decoded ${measured.settledDecodesPerSecond}/s while idle > ${BUDGET.settledDecodesPerSecond}/s`,
      measured.idleJsonBytesPerSecond > BUDGET.idleJsonBytesPerSecond && `idle JSON decode ${measured.idleJsonBytesPerSecond} B/s > ${BUDGET.idleJsonBytesPerSecond} B/s`,
      WALLCLOCK && measured.loopLagMaxMs > BUDGET.loopLagMaxMs && `event-loop lag max ${measured.loopLagMaxMs} ms > ${BUDGET.loopLagMaxMs} ms`,
      WALLCLOCK && measured.helloP99Ms > BUDGET.helloP99Ms && `/v3/hello p99 ${measured.helloP99Ms} ms > ${BUDGET.helloP99Ms} ms`,
    ].filter(Boolean);
    expect(violations).toEqual([]);
  } finally {
    counting = false;
    JSON.parse = realParse;
    await server.stop();
  }
}, 120_000);
