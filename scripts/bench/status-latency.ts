/**
 * B12-1 status-read latency benchmark against a live sandbox.
 *
 * Measures the wall time of the five status read surfaces a user or client hits:
 *   status-line   `pacer status --line --no-color` through the Rust front door
 *   v3-snapshot   GET  /v3/snapshot      (token-protected local API)
 *   v2-snapshot   GET  /v1/snapshot      (legacy v2 surface)
 *   limits.check  POST /v3/ops/limits.check {}
 *   snapshot.get  POST /v3/ops/snapshot.get {}
 *
 * It requires a Rust-front-door live sandbox (`bun run live up --front-door rust ...`)
 * and refuses to run against the maintainer's real pacer install (real-install-guard).
 * Runs come after an optional `--warmup` count so caches and JIT are warm, and the
 * five surfaces are interleaved round-robin so no one path enjoys a cold cache.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSession, sandboxEnv, pacerArgv, type Session } from "../live/core";
import { assertNotRealInstall } from "../lib/real-install-guard";

/** Math.round((q / 100) * n) nearest-rank percentile over a sorted ascending sample. */
export function nearestRank(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile of an empty sample");
  const rank = Math.ceil((q / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1]!;
}

export interface StatusLatencyRow {
  runs: number;
  p50: number;
  p95: number;
  max: number;
}
export type StatusLatencyResult = Record<string, StatusLatencyRow>;

export const RUST_DOOR_REQUIRED = "status bench needs a --front-door rust sandbox";

/** Refuse a binary/PACER_HOME that would hit the real install, sandboxed home only. */
function guard(session: Session) {
  if (session.frontDoor !== "rust") throw new Error(RUST_DOOR_REQUIRED);
  const argv = pacerArgv(session);
  const env = sandboxEnv(session);
  assertNotRealInstall(argv[0]!, `benchmark status reads against the front door`);
  assertNotRealInstall(env.PACER_HOME!, `benchmark status reads against the sandbox home`);
  return { argv, env };
}

/** Wall clock of one `pacer status --line --no-color` through the Rust front door. */
function statusLine(argv: string[], env: NodeJS.ProcessEnv): number {
  const start = performance.now();
  Bun.spawnSync([...argv, "status", "--line", "--no-color"], { env, cwd: join(env.PACER_HOME ?? "", ".."), timeout: 30000 });
  return performance.now() - start;
}

/** One token-protected fetch; returns wall clock in ms, throwing on non-OK. */
async function fetchMs(url: string, token: string, init?: RequestInit): Promise<number> {
  const start = performance.now();
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  await res.arrayBuffer();
  return performance.now() - start;
}

/** Bunch of one path-weighted round so every surface is measured under the same warm cache. */
async function round(s: { argv: string[]; env: NodeJS.ProcessEnv; token: string; port: number }): Promise<Record<string, number>> {
  const base = `http://127.0.0.1:${s.port}`;
  const [status, v3, v2, lc, sg] = await Promise.all([
    Promise.resolve().then(() => statusLine(s.argv, s.env)),
    fetchMs(`${base}/v3/snapshot`, s.token),
    fetchMs(`${base}/v1/snapshot`, s.token),
    fetchMs(`${base}/v3/ops/limits.check`, s.token, { method: "POST", body: "{}" }),
    fetchMs(`${base}/v3/ops/snapshot.get`, s.token, { method: "POST", body: "{}" }),
  ]);
  return { "status-line": status, "v3-snapshot": v3, "v2-snapshot": v2, "limits.check": lc, "snapshot.get": sg };
}

async function bench(session: Session, runs: number, warmup: number): Promise<StatusLatencyResult> {
  const { argv, env } = guard(session);
  const token = readFileSync(join(session.root, "home", "token"), "utf8").trim();
  const s = { argv, env, token, port: session.port };
  for (let i = 0; i < warmup; i++) await round(s);
  const byPath: Record<string, number[]> = { "status-line": [], "v3-snapshot": [], "v2-snapshot": [], "limits.check": [], "snapshot.get": [] };
  for (let i = 0; i < runs; i++) {
    const r = await round(s);
    for (const [path, ms] of Object.entries(r)) byPath[path]!.push(ms);
  }
  const out: StatusLatencyResult = {};
  for (const [path, samples] of Object.entries(byPath)) {
    const sorted = [...samples].sort((a, b) => a - b);
    out[path] = { runs: samples.length, p50: nearestRank(sorted, 50), p95: nearestRank(sorted, 95), max: sorted[sorted.length - 1]! };
  }
  return out;
}

function render(result: StatusLatencyResult, runs: number): string {
  const rows = Object.entries(result).sort((a, b) => a[1].p50 - b[1].p50);
  const lines = [
    `pacer status read latency (${runs} runs, nearest-rank)`,
    `${"path".padEnd(14)} ${"runs".padStart(6)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`,
    ...rows.map(([path, r]) => `${path.padEnd(14)} ${String(r.runs).padStart(6)} ${r.p50.toFixed(1).padStart(8)} ${r.p95.toFixed(1).padStart(8)} ${r.max.toFixed(1).padStart(8)}`),
  ];
  return lines.join("\n");
}

const usage = `usage: bun scripts/bench/status-latency.ts [--id <id>] [--runs N] [--warmup N] [--out <file>]`;

function parseArgs(argv: string[]): { id?: string; runs: number; warmup: number; out?: string } {
  const args: Record<string, string> = {};
  let runs = 100, warmup = 10, out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--id" || a === "--runs" || a === "--warmup" || a === "--out") {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      if (a === "--id") args.id = v;
      else if (a === "--runs") runs = Number(v);
      else if (a === "--warmup") warmup = Number(v);
      else out = v;
    } else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error("--warmup must be a non-negative integer");
  return { id: args.id, runs, warmup, out };
}

async function main(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  const session = loadSession(opts.id);
  const result = await bench(session, opts.runs, opts.warmup);
  const table = render(result, opts.runs);
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(result, null, 2) + "\n");
    console.log(`wrote ${opts.out}`);
  }
  console.log(table);
  return 0;
}

if (process.argv[1] && import.meta.path === process.argv[1]) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
}

export { bench, guard, main, parseArgs, render, fetchMs, statusLine };