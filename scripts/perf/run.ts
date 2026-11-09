/**
 * Core responsiveness benchmark (`bun run perf`).
 *
 * Builds a synthetic PACER_HOME (scripts/perf/synthetic-home.ts) in a temp dir, starts `pacer serve`
 * from source against it (scripts/perf/serve-child.ts), probes GET /v3/hello at a fixed cadence and
 * records latency, event-loop lag inside the service, startup-to-ready time and CPU.
 *
 *   bun run perf [--tasks 5000[,2000...]] [--unsettled 10] [--mode worker|inprocess|both]
 *                [--seconds 60] [--warmup 10] [--interval 500] [--out <dir>] [--port <n>]
 *                [--cpu-prof-md] [--keep]
 *
 * --mode inprocess forces the service's in-process supervision fallback (see serve-child.ts).
 * Probes may overlap; one unanswered after 120 s counts as an error at 120 s. Lag "steady" starts
 * --warmup seconds after the first successful probe. The service runs with a temp HOME and
 * PACER_HOME, a minimal PATH with no executor CLIs, and is killed with its process group.
 *
 * Results go to <out>/results.{json,md} plus one directory per run (serve log, probe samples,
 * lag/CPU samples, optional CPU profile). The default <out> is .work/perf/<timestamp> (untracked).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { assertNotRealInstall } from "../lib/real-install-guard";
import { installKeychainStub } from "../live/keychain";
import { buildSyntheticHome } from "./synthetic-home";

const REPO = resolve(import.meta.dir, "../..");
const EXECUTOR_BINS = ["claude", "codex", "cursor-agent", "agent", "opencode", "agy", "gemini", "ollama", "lms", "arkcli"];
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface ProbeSample { at: number; ms: number; status: number }
export interface LatencySummary { n: number; errors: number; p50: number; p95: number; p99: number; max: number; over100: number; over500: number }
export interface LagSummary { samples: number; max: number; p99: number; over100: number; over500: number; over1000: number; blockedPct: number }
export interface RunResult {
  label: string; tasks: number; unsettled: number; mode: "worker" | "inprocess"; seconds: number; warmup: number;
  readyMs: number | null; hello: LatencySummary; helloSteady: LatencySummary;
  lagAll: LagSummary | null; lagSteady: LagSummary | null; cpuPctSteady: number | null; cpuPctAll: number | null;
  /** > 0 when the service was blocked as the stop arrived; included in the lag summaries. */
  stalledAtStopMs: number;
  avgRecordBytes: number; buildMs: number; dir: string; leftovers: string[];
}

function parseArgs(argv: string[]) {
  const opts = {
    tasks: [5000], unsettled: 10, modes: ["worker", "inprocess"] as ("worker" | "inprocess")[], seconds: 60, warmup: 10,
    interval: 500, out: "", port: 0, cpuProf: false, keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!, value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    const int = (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} needs a non-negative integer, got ${v}`);
      return n;
    };
    switch (flag) {
      case "--tasks": opts.tasks = value().split(",").map(int); break;
      case "--unsettled": opts.unsettled = int(value()); break;
      case "--mode": {
        const v = value();
        if (v !== "worker" && v !== "inprocess" && v !== "both") throw new Error("--mode is worker, inprocess or both");
        opts.modes = v === "both" ? ["worker", "inprocess"] : [v];
        break;
      }
      case "--seconds": opts.seconds = int(value()); break;
      case "--warmup": opts.warmup = int(value()); break;
      case "--interval": opts.interval = Math.max(50, int(value())); break;
      case "--out": opts.out = resolve(value()); break;
      case "--port": opts.port = int(value()); break;
      case "--cpu-prof-md": opts.cpuProf = true; break;
      case "--keep": opts.keep = true; break;
      case "--help": case "-h":
        console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]!.replace(/^\/\*\*|^ \* ?/gm, "").trim());
        process.exit(0);
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  opts.out ||= join(REPO, ".work", "perf", new Date().toISOString().replace(/[:.]/g, "-"));
  return opts;
}

const quantile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : 0;
const round = (n: number) => Math.round(n * 10) / 10;

export function summarizeLatency(samples: ProbeSample[]): LatencySummary {
  const ms = samples.map(s => s.ms).sort((a, b) => a - b);
  return {
    n: ms.length, errors: samples.filter(s => s.status !== 200).length,
    p50: round(quantile(ms, 0.5)), p95: round(quantile(ms, 0.95)), p99: round(quantile(ms, 0.99)), max: round(ms.at(-1) ?? 0),
    over100: ms.filter(x => x > 100).length, over500: ms.filter(x => x > 500).length,
  };
}

/** Lag ticks are [epoch ms at the end of the tick, lag ms]; blocked% is lag time over the window. */
export function summarizeLag(lag: [number, number][], from: number, to: number): LagSummary | null {
  const inWindow = lag.filter(([at]) => at >= from && at <= to);
  if (!inWindow.length) return null;
  const values = inWindow.map(([, l]) => l).sort((a, b) => a - b);
  const blocked = values.reduce((sum, l) => sum + l, 0);
  return {
    samples: values.length, max: values.at(-1)!, p99: quantile(values, 0.99),
    over100: values.filter(l => l > 100).length, over500: values.filter(l => l > 500).length, over1000: values.filter(l => l > 1000).length,
    blockedPct: round(100 * blocked / Math.max(1, to - from)),
  };
}

export function cpuPercent(cpu: [number, number, number][], from: number, to: number): number | null {
  const inWindow = cpu.filter(([at]) => at >= from && at <= to);
  if (inWindow.length < 2) return null;
  const a = inWindow[0]!, b = inWindow.at(-1)!;
  return round(100 * ((b[1] + b[2]) - (a[1] + a[2])) / 1000 / Math.max(1, b[0] - a[0]));
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port!;
  server.stop(true);
  return port;
}

// Homes hold tens of thousands of files; copy and delete them in child processes so this
// process keeps handling signals.
async function sh(argv: string[]): Promise<number> {
  return await Bun.spawn(argv, { stdio: ["ignore", "inherit", "inherit"] }).exited;
}
async function removeTree(path: string): Promise<void> {
  if (existsSync(path) && await sh(["rm", "-rf", path]) !== 0) throw new Error(`could not remove ${path}`);
}
async function cloneTree(from: string, to: string): Promise<void> {
  await removeTree(to);
  const args = process.platform === "darwin" ? ["-cR", from, to] : ["-R", "--reflink=auto", from, to];
  if (await sh(["cp", ...args]) === 0) return;
  await removeTree(to);
  if (await sh(["cp", "-R", from, to]) !== 0) throw new Error(`could not copy ${from} to ${to}`);
}

/**
 * Every process other than this one whose command line or environment mentions the sandbox root.
 * Service children inherit PACER_HOME/HOME under the root, so this also finds detached descendants.
 */
function sandboxProcesses(root: string): { pid: number; command: string }[] {
  const ps = spawnSync("ps", ["axeww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return (ps.stdout ?? "").split("\n").flatMap(line => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === process.pid || !m[2]!.includes(root)) return [];
    const command = m[2]!.split(/\s[A-Z_][A-Z0-9_]*=/)[0]!;
    return [{ pid: Number(m[1]), command }];
  });
}

const killGroup = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* group already gone */ } };

async function stopChild(child: ChildProcess, root: string, onStop: () => void): Promise<string[]> {
  const pid = child.pid!;
  onStop();
  killGroup(pid, "SIGTERM");
  const deadline = Date.now() + 15_000;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await Bun.sleep(100);
  killGroup(pid, "SIGKILL");
  await Bun.sleep(300);
  const leftovers = sandboxProcesses(root);
  for (const p of leftovers) { try { process.kill(p.pid, "SIGKILL"); } catch { /* exited */ } }
  return leftovers.map(p => `${p.pid} ${p.command}`);
}

async function probeOnce(port: number, token: string, timeoutMs: number): Promise<ProbeSample> {
  const at = Date.now(), t0 = performance.now();
  let status = 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v3/hello`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    status = r.status;
    await r.arrayBuffer();
  } catch { status = -1; }
  return { at, ms: performance.now() - t0, status };
}

interface Sandbox { root: string; live: string; pacerHome: string; home: string; bin: string; tmp: string; repos: string[] }

function childEnv(s: Sandbox, port: number, mode: string, statsFile: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: s.home, PACER_HOME: s.pacerHome, PACER_PORT: String(port), PACER_NO_UPDATE_CHECK: "1", PACER_BACKEND: "direct",
    PACER_LOGIN_ENV: "off", PATH: `${s.bin}:${SYSTEM_PATH}`, TMPDIR: s.tmp, USER: userInfo().username, LANG: "en_US.UTF-8",
    TZ: "UTC", PERF_SUPERVISION: mode, PERF_PORT: String(port), PERF_STATS_FILE: statsFile,
  };
  for (const bin of EXECUTOR_BINS) {
    const found = Bun.which(bin, { PATH: env.PATH });
    if (found) throw new Error(`refusing to run: executor ${bin} is reachable on the sandbox PATH (${found})`);
  }
  return env;
}

async function runOnce(s: Sandbox, o: ReturnType<typeof parseArgs>, mode: "worker" | "inprocess", tasks: number, build: { avgRecordBytes: number; buildMs: number }, register: (child: ChildProcess | undefined) => void): Promise<RunResult> {
  const label = `${tasks}-${mode}`;
  const dir = join(o.out, label);
  mkdirSync(dir, { recursive: true });
  const port = o.port || await freePort();
  const statsFile = join(dir, "stats.json");
  const env = childEnv(s, port, mode, statsFile);
  const log = openSync(join(dir, "serve.log"), "w");
  const bunArgs = o.cpuProf ? ["--cpu-prof-md", `--cpu-prof-dir=${join(dir, "prof")}`] : [];
  const spawnedAt = Date.now();
  const child = spawn(process.execPath, [...bunArgs, join(import.meta.dir, "serve-child.ts")], { cwd: REPO, env, detached: true, stdio: ["ignore", log, log] });
  register(child);
  const tokenFile = join(s.pacerHome, "token");
  let token = "", readyAt: number | null = null;
  const readyDeadline = Date.now() + 180_000;
  while (Date.now() < readyDeadline && child.exitCode === null) {
    if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, "utf8").trim();
    if (token && (await probeOnce(port, token, 2_000)).status === 200) { readyAt = Date.now(); break; }
    await Bun.sleep(100);
  }
  const samples: ProbeSample[] = [];
  if (readyAt !== null) {
    console.error(`perf: ${label} ready after ${((readyAt - spawnedAt) / 1000).toFixed(1)} s; probing for ${o.seconds} s`);
    const pending: Promise<void>[] = [];
    while (Date.now() - readyAt < o.seconds * 1000) {
      pending.push(probeOnce(port, token, 120_000).then(sample => { samples.push(sample); }));
      await Bun.sleep(o.interval);
    }
    await Promise.all(pending);
  } else console.error(`perf: ${label} never became ready; see ${join(dir, "serve.log")}`);
  let endedAt = Date.now();
  const leftovers = await stopChild(child, s.root, () => { endedAt = Date.now(); });
  register(undefined);
  samples.sort((a, b) => a.at - b.at);
  const stats = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, "utf8")) as { flushedAt: number; final: boolean; lag: [number, number][]; cpu: [number, number, number][] } : null;
  // No final flush means the main loop was blocked when the stop arrived: everything since the
  // last flush counts as one stall in progress (a lower bound on it).
  const stalledAtStopMs = stats && !stats.final ? Math.max(0, endedAt - stats.flushedAt) : 0;
  if (stats && stalledAtStopMs > 0) stats.lag.push([endedAt, stalledAtStopMs]);
  const steadyFrom = (readyAt ?? endedAt) + o.warmup * 1000;
  const result: RunResult = {
    label, tasks, unsettled: o.unsettled, mode, seconds: o.seconds, warmup: o.warmup,
    readyMs: readyAt === null ? null : readyAt - spawnedAt,
    hello: summarizeLatency(samples), helloSteady: summarizeLatency(samples.filter(x => x.at >= steadyFrom)),
    lagAll: stats && readyAt !== null ? summarizeLag(stats.lag, readyAt, endedAt) : null,
    lagSteady: stats ? summarizeLag(stats.lag, steadyFrom, endedAt) : null,
    cpuPctSteady: stats ? cpuPercent(stats.cpu, steadyFrom, endedAt) : null,
    cpuPctAll: stats && readyAt !== null ? cpuPercent(stats.cpu, readyAt, endedAt) : null,
    stalledAtStopMs, avgRecordBytes: build.avgRecordBytes, buildMs: build.buildMs, dir, leftovers,
  };
  writeFileSync(join(dir, "probe.json"), JSON.stringify({ samples }, null, 1));
  writeFileSync(join(dir, "summary.json"), JSON.stringify(result, null, 2));
  if (leftovers.length) console.error(`perf: WARNING killed leftover sandbox processes:\n  ${leftovers.join("\n  ")}`);
  return result;
}

const cell = (v: number | null | undefined, unit = "") => v === null || v === undefined ? "n/a" : `${v}${unit}`;
export function markdownTable(results: RunResult[]): string {
  const rows = results.map(r => [
    r.tasks, r.mode, r.readyMs === null ? "never" : (r.readyMs / 1000).toFixed(1),
    r.hello.n, r.hello.errors, r.hello.p50, r.hello.p95, r.hello.p99, r.hello.max, r.hello.over100, r.hello.over500,
    cell(r.lagSteady?.max), cell(r.lagSteady?.p99), cell(r.lagSteady?.over100), cell(r.lagAll?.max), cell(r.lagSteady?.blockedPct, "%"),
    cell(r.cpuPctSteady, "%"), r.stalledAtStopMs,
  ].join(" | "));
  return [
    "| tasks | supervision | ready s | hello n | errors | p50 ms | p95 ms | p99 ms | max ms | >100 ms | >500 ms | lag max ms (steady) | lag p99 ms (steady) | lag >100 ms ticks (steady) | lag max ms (after ready) | blocked (steady) | CPU (steady) | stalled at stop ms |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(r => `| ${r} |`),
  ].join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const realHome = userInfo().homedir;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pacer-perf-")));
  const bin = join(root, "bin"), tmp = join(root, "tmp");
  // One directory per home size: the builder's store connection is cached by path.
  const sandbox = (tasks: number): Sandbox => {
    const live = join(root, `home-${tasks}`);
    const s = {
      root, live, pacerHome: join(live, "pacer"), home: join(live, "home"), bin, tmp,
      repos: ["alpha", "beta", "gamma"].map(name => join(live, "repos", name)),
    };
    for (const [name, path] of [["PACER_HOME", s.pacerHome], ["HOME", s.home]] as const) assertNotRealInstall(path, `run the perf benchmark with ${name}`, realHome);
    return s;
  };
  o.tasks.forEach(sandbox);
  mkdirSync(bin, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  mkdirSync(o.out, { recursive: true });
  symlinkSync(process.execPath, join(bin, "bun"));
  installKeychainStub(bin, join(root, "keychain"));

  let current: ChildProcess | undefined;
  const cleanup = () => {
    if (current?.pid) killGroup(current.pid, "SIGKILL");
    for (const p of sandboxProcesses(root)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* exited */ } }
    if (!o.keep) rmSync(root, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => { cleanup(); process.exit(130); });

  const results: RunResult[] = [];
  try {
    for (const tasks of o.tasks) {
      const s = sandbox(tasks);
      console.error(`perf: building a synthetic home with ${tasks} settled + ${o.unsettled} unsettled tasks`);
      let lastLog = 0;
      const build = buildSyntheticHome({
        pacerHome: s.pacerHome, home: s.home, repos: s.repos, settled: tasks, unsettled: o.unsettled,
        onProgress: (done, total) => { if (Date.now() - lastLog > 5000) { lastLog = Date.now(); console.error(`perf:   ${done}/${total}`); } },
      });
      console.error(`perf: built in ${(build.buildMs / 1000).toFixed(1)} s, avg record ${build.avgRecordBytes} bytes`);
      // Every run starts from the same home: keep an untouched copy for each run but the last.
      // Task records hold absolute paths, so the copy is renamed into place rather than used where it is.
      const spare = `${s.live}-spare`;
      for (const [index, mode] of o.modes.entries()) {
        const another = index < o.modes.length - 1;
        if (another) await cloneTree(s.live, spare);
        const result = await runOnce(s, o, mode, tasks, build, child => { current = child; });
        results.push(result);
        writeFileSync(join(o.out, "results.json"), JSON.stringify(results, null, 2));
        writeFileSync(join(o.out, "results.md"), `${markdownTable(results)}\n`);
        if (another) {
          await removeTree(s.live);
          renameSync(spare, s.live);
        }
      }
      if (!o.keep) await removeTree(s.live);
    }
  } finally {
    for (const p of sandboxProcesses(root)) { try { process.kill(p.pid, "SIGKILL"); } catch { /* exited */ } }
  }
  if (!o.keep) await removeTree(root);
  console.log(markdownTable(results));
  console.log(`\nresults: ${join(o.out, "results.md")}`);
  if (results.some(r => r.leftovers.length || r.readyMs === null)) process.exitCode = 1;
}

if (import.meta.main) await main();
