/**
 * Builds a synthetic PACER_HOME for performance work: N settled tasks at a realistic record size
 * (~20 KB of JSON with attempts, routing notes, token counts and reports), their run directories,
 * a few MB of labels.jsonl and decisions.jsonl, a few strategies, and a handful of unsettled tasks.
 *
 * Task records go through the real store (`createTask` / `updateTask`), so tasks.db and the
 * compatibility JSON stay consistent. No real process ids appear anywhere: every pid field and
 * run-dir `pid` file holds FAKE_PID, which is above any platform's PID_MAX. Unsettled tasks are
 * queued behind a far-future retry so neither the pump nor supervision tries to launch them.
 * Settled tasks look already swept (resolved, worktrees gone outside the managed worktrees root),
 * so a service started on the home measures steady state rather than a one-time cleanup pass.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoFor } from "../../src/core/repos";
import { createTask, updateTask } from "../../src/tasks/store";
import { TERMINAL_STATES, type Attempt, type TaskRecord, type TaskState } from "../../src/tasks/types";
import type { Ctx } from "../../src/types";

export const FAKE_PID = 9_999_999;

export interface SyntheticHomeOptions {
  pacerHome: string;
  home: string;
  /** Repositories referenced by the tasks; created as empty git repos if they don't exist. */
  repos: string[];
  settled: number;
  unsettled: number;
  /** Epoch seconds of the newest task. */
  now?: number;
  /** Bytes of labels.jsonl and decisions.jsonl each. */
  logBytes?: number;
  /** "last" writes only the final attempt's run directory, for faster fixtures. Default "all". */
  runDirs?: "all" | "last";
  onProgress?: (done: number, total: number) => void;
}

export interface SyntheticHomeSummary {
  settled: number;
  unsettled: number;
  settledIds: string[];
  avgRecordBytes: number;
  buildMs: number;
}

const EXECUTORS = ["codex", "cursor", "claude-code", "opencode"] as const;
const SETTLED_STATES: TaskState[] = ["done", "done", "done", "done", "partial", "failed", "stopped", "limit"];

// Deterministic filler, so record sizes and contents are stable across runs.
const CORPUS = (() => {
  const words = ["router", "budget", "attempt", "worktree", "acceptance", "snapshot", "executor", "planner",
    "refactor", "migration", "latency", "index", "settled", "review", "branch", "diff", "pacing", "quota"];
  const out: string[] = [];
  for (let i = 1, n = 0; n < 96_000; i = (i * 31 + 7) % 104_729) {
    const word = words[i % words.length] + ((i % 11) === 0 ? ".\n" : " ");
    out.push(word);
    n += word.length;
  }
  return out.join("");
})();
function prose(seed: number, bytes: number): string {
  const start = (seed * 7_919) % (CORPUS.length - bytes);
  return CORPUS.slice(start, start + bytes);
}

function hex(seed: number, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += ((seed * 2_654_435_761 + i * 40_503) >>> 0).toString(16).padStart(8, "0");
  return out.slice(0, length);
}

function attempt(seed: number, index: number, startedAt: number, runDir: string, last: boolean, state: TaskState): Attempt {
  const executor = EXECUTORS[(seed + index) % EXECUTORS.length]!;
  const endedAt = startedAt + 240 + (seed % 900);
  const usage = (at: number, pct: number) => ({ account: `${executor}-main`, usedPct: pct, window: "5h", at, poolId: `${executor}:pool`, resetEpoch: at + 18_000, capturedAt: at, observationId: `obs-${hex(seed + index, 12)}` });
  return {
    executor, model: `${executor}-model-${index}`, actualModel: `${executor}-model-${index}-2026`,
    dispatchSettingsHash: hex(seed * 3 + index, 40),
    startedAt, endedAt, exitCode: last && state === "done" ? 0 : 1, timedOut: false, limitHit: last && state === "limit",
    log: join(runDir, "stdout"),
    routing: {
      kind: index % 2 ? "feature" : "fix", kindSource: "classifier", rule: "default",
      chosen: executor, why: prose(seed + index, 400),
      skipped: EXECUTORS.filter(e => e !== executor).map(e => ({ executor: e, reason: prose(seed + e.length, 160) })),
      policy: { source: "project", repoKey: `repo-${seed % 3}`, rev: 3, executors: [...EXECUTORS] },
    },
    usageAtStart: usage(startedAt, 20 + (seed % 50)),
    usageAtEnd: usage(endedAt, 25 + (seed % 60)),
    tokens: {
      coverage: "measured", input: 40_000 + seed % 9_000, cacheRead: 220_000, cacheWrite: 18_000, output: 9_000,
      reasoning: 3_000, total: 49_000 + seed % 9_000, turns: 30 + seed % 40, source: "executor-json",
      selfReported: false, extractor: `${executor}-stream-json@1`, capturedAt: endedAt,
    },
  };
}

function writeRunDir(dir: string, seed: number, startedAt: number, exitCode: number, withDiff: boolean, worktree: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "pid"), String(FAKE_PID));
  writeFileSync(join(dir, "started"), String(Math.floor(startedAt)));
  writeFileSync(join(dir, "exit"), String(exitCode));
  writeFileSync(join(dir, "stdout"), prose(seed, 6_000));
  writeFileSync(join(dir, "stderr"), prose(seed + 1, 400));
  if (!withDiff) return;
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `src/module-${seed % 40}/file-${i}.ts`, status: "modified", added: 10 + i, removed: i, binary: false }));
  const patch = files.map(f => `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,3 +1,4 @@\n+${prose(seed + f.added, 300)}\n`).join("");
  writeFileSync(join(dir, "diff.json"), JSON.stringify({ base: hex(seed, 40), worktree, files, patch, diff: patch, untracked: [], truncated: false }));
}

function ensureRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  const r = Bun.spawnSync(["sh", "-c", "[ -d .git ] || (git init -q -b main && git -c user.email=perf@example.invalid -c user.name=perf commit -q --allow-empty -m init)"], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`could not create synthetic repo ${repo}: ${r.stderr.toString()}`);
}

const STRATEGY = (planner: string, executors: string[]) => [
  `planner: ${planner}`,
  "providers:",
  ...executors.map(e => `  ${e}: {usage: unmetered}`),
  "pacing: {policy: priority, planner_reserve: 15}",
  "routing:",
  `  - default: [${executors.filter(e => e !== planner).join(", ")}]`,
  "",
].join("\n");

function writeStrategies(pacerHome: string): void {
  writeFileSync(join(pacerHome, "strategy.yaml"), STRATEGY("claude-code", ["claude-code", "codex", "cursor"]));
  mkdirSync(join(pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(pacerHome, "strategies", "fast.yaml"), STRATEGY("codex", ["codex", "cursor"]));
  writeFileSync(join(pacerHome, "strategies", "careful.yaml"), STRATEGY("claude-code", ["claude-code", "codex"]));
  writeFileSync(join(pacerHome, "strategies", "cheap.yaml"), STRATEGY("cursor", ["cursor", "codex", "opencode"]));
}

function writeLogs(pacerHome: string, ids: string[], now: number, bytes: number): void {
  const labels: string[] = [], decisions: string[] = [];
  let labelBytes = 0, decisionBytes = 0;
  for (let i = 0; labelBytes < bytes || decisionBytes < bytes; i++) {
    const id = ids[i % ids.length]!, ts = now - (ids.length - (i % ids.length)) * 60;
    if (labelBytes < bytes) {
      const line = JSON.stringify({ ts, task_id: id, kind: i % 2 ? "feature" : "fix", executor: EXECUTORS[i % EXECUTORS.length], accepted: i % 5 !== 0, note: prose(i, 260) });
      labels.push(line); labelBytes += line.length + 1;
    }
    if (decisionBytes < bytes) {
      const line = JSON.stringify({
        ts, id: `d-${hex(i, 12)}`, decision: "classify", state_hash: hex(i + 1, 16), state: null,
        question: { prompt: prose(i + 2, 300) }, adapter: "heuristic", answer: { kind: "feature", confidence: 0.8 },
        acted_on: true, fallback: false, task_id: id,
      });
      decisions.push(line); decisionBytes += line.length + 1;
    }
  }
  writeFileSync(join(pacerHome, "labels.jsonl"), labels.join("\n") + "\n");
  writeFileSync(join(pacerHome, "decisions.jsonl"), decisions.join("\n") + "\n", { mode: 0o600 });
}

function ctxAt(o: SyntheticHomeOptions, now: number): Ctx {
  return {
    home: o.home, pacerHome: o.pacerHome, now, env: { HOME: o.home, PACER_HOME: o.pacerHome },
    run: async () => ({ code: 127, stdout: "", stderr: "not available while building a synthetic home" }),
    which: () => null,
  };
}

export function buildSyntheticHome(o: SyntheticHomeOptions): SyntheticHomeSummary {
  const t0 = performance.now();
  const now = Math.floor(o.now ?? Date.now() / 1000);
  mkdirSync(o.pacerHome, { recursive: true, mode: 0o700 });
  mkdirSync(o.home, { recursive: true });
  for (const repo of o.repos) ensureRepo(repo);
  writeStrategies(o.pacerHome);
  const total = o.settled + o.unsettled;
  // One task every 7 minutes, newest at `now`: unique per-second ids and a realistic spread.
  const spacing = 420;
  const ids: string[] = [];
  let recordBytes = 0;
  // The store rescans tasks/ whenever the directory changes, which makes building N tasks O(N²).
  // Park each finished task's JSON outside tasks/ and move it back at the end; rename keeps the
  // mtime the store recorded, so the final scan imports nothing.
  const tasks = join(o.pacerHome, "tasks"), parked = join(o.pacerHome, ".perf-parked-tasks");
  mkdirSync(parked, { recursive: true });
  const park = (id: string) => renameSync(join(tasks, `${id}.json`), join(parked, `${id}.json`));
  for (let i = 0; i < total; i++) {
    const seed = i + 1;
    const createdAt = now - (total - i) * spacing;
    const repo = o.repos[i % o.repos.length]!;
    const ctx = ctxAt(o, createdAt);
    const task = createTask(ctx, {
      title: `Synthetic task ${seed}: ${prose(seed, 40).trim()}`,
      brief: {
        goal: prose(seed, 700), repo, scope: prose(seed + 2, 200), acceptance: "bun run typecheck && bun run test",
        constraints: prose(seed + 3, 300), context: prose(seed + 4, 2_500),
      },
      kind: seed % 2 ? "feature" : "fix", requestedExecutor: null, timeoutS: 1_800, source: "planner",
      placement: { requested: "auto" },
    });
    ids.push(task.id);
    // Real tasks record their repository when they launch (tasks/drain.ts, tasks/runner.ts).
    const repoRef = repoFor(ctx, repo);
    if (i >= o.settled) {
      updateTask(ctx, task.id, t => {
        t.repo = repoRef;
        t.queue = { reason: "waiting_retry", nextAt: now + 30 * 86_400, since: createdAt, position: i - o.settled + 1, detail: "synthetic unsettled task" };
      });
      park(task.id);
      continue;
    }
    const state = SETTLED_STATES[seed % SETTLED_STATES.length]!;
    const attempts = 1 + (seed % 3);
    const worktree = join(o.home, "worktrees", task.id);
    const runs: Attempt[] = [];
    let at = createdAt + 5;
    for (let a = 1; a <= attempts; a++) {
      const dir = join(o.pacerHome, "runs", task.id, String(a));
      const record = attempt(seed, a, at, dir, a === attempts, state);
      if (a === attempts || o.runDirs !== "last") writeRunDir(dir, seed + a, at, record.exitCode, a === attempts, worktree);
      runs.push(record);
      at = record.endedAt + 30;
    }
    const last = runs.at(-1)!;
    const settledCtx = ctxAt(o, last.endedAt + 5);
    const updated = updateTask(settledCtx, task.id, (t: TaskRecord) => {
      t.repo = repoRef;
      t.attempts = runs;
      t.executor = last.executor;
      t.backend = "direct";
      t.attemptStartedAt = last.startedAt;
      t.runnerPid = FAKE_PID;
      t.childPid = FAKE_PID;
      t.baseBranch = "main";
      t.baseSha = hex(seed, 40);
      t.worktree = worktree;
      t.placement = { requested: "auto", mode: "new", why: "strategy default" };
      t.run = {
        dir: join(o.pacerHome, "runs", task.id, String(attempts)), attempt: attempts, executor: last.executor,
        startedAt: last.startedAt, mode: "new", workdir: worktree, logFile: last.log,
      };
      t.result = {
        status: state as Exclude<TaskState, "queued" | "running">, executor: last.executor, model: last.model, backend: "direct",
        report: prose(seed + 9, 7_000), files: prose(seed + 10, 600), worktree,
        acceptance: { cmd: "bun run typecheck && bun run test", passed: state === "done", tail: prose(seed + 11, 2_000), durationS: 42, exitCode: state === "done" ? 0 : 1, shell: "/bin/sh" },
      };
      if (state === "done") t.review = { accepted: seed % 4 !== 0, kind: "feature", note: prose(seed + 12, 300), at: last.endedAt + 60 };
      // What the resolver records once a settled task's worktree is gone; without it the first
      // service start resolves (rewrites) every partial/failed task instead of reaching steady state.
      if (state === "partial" || state === "failed") t.resolved = "worktree removed";
      t.state = state;
    });
    if (!TERMINAL_STATES.includes(updated.state)) throw new Error(`synthetic task ${task.id} did not settle`);
    recordBytes += JSON.stringify(updated).length;
    park(task.id);
    o.onProgress?.(i + 1, total);
  }
  for (const name of readdirSync(parked)) renameSync(join(parked, name), join(tasks, name));
  rmSync(parked, { recursive: true });
  writeLogs(o.pacerHome, ids, now, o.logBytes ?? 3 * 1024 * 1024);
  return {
    settled: o.settled, unsettled: o.unsettled, settledIds: ids.slice(0, o.settled),
    avgRecordBytes: o.settled ? Math.round(recordBytes / o.settled) : 0,
    buildMs: Math.round(performance.now() - t0),
  };
}
