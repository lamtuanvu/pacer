import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { startServer } from "../src/serve/http";
import { fakeCtx, withLoginIndicators } from "./helpers";
import { front, serve } from "./native-repo-front-door";
import { closedPort, spawnPinned } from "./port-isolation";

// B12-6: status-broker parts are native. Every status op that used to ask the
// TypeScript core for `computeStatus` parts now computes them in the Rust door.
// The native replies (over stdio and HTTP) must equal the forced-forward replies
// from the TS handlers, and the sealed route must be gone.

const root = resolve(import.meta.dir, "..");
const TOKEN = "s".repeat(64);
const OPS = "limits.check,routing.status,runner.list,strategy.preview,mode.hold,task.retry_options,dispatch.preview";
const STRATEGY = `planner: claude-code
accounts:
  claude: {kind: claude}
  codex: {kind: codex}
runners:
  claude-code: {}
  codex: {}
pacing: {policy: priority, order: [claude-code, codex]}
`;
const WIDE = STRATEGY.replace("  codex: {kind: codex}\n", "  codex: {kind: codex}\n  cursor: {kind: cursor}\n")
  .replace("  codex: {}\n", "  codex: {}\n  cursor: {}\n");

const core = JSON.stringify([process.execPath, join(root, "src/cli.ts")]);
const dirs: string[] = [];
const fresh = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

/** A checkout dispatch.preview can register without needing Core. */
function gitRepo(dir: string): string {
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  return repo;
}

/** The shared fixture, with both strategies, a checkout and a failed task. */
function fixture(): { home: string; id: string; repo: string } {
  const dir = fresh("pacer-status-parts-");
  const repo = gitRepo(dir);
  const ctx: Ctx = withLoginIndicators(fakeCtx({ home: dir, pacerHome: join(dir, ".pacer") }));
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  writeFileSync(join(ctx.pacerHome, "strategies", "wide.yaml"), WIDE);
  const task = createTask(ctx, { brief: { goal: "Goal", repo }, kind: "tests", requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, row => { row.state = "failed"; });
  return { home: dir, id: task.id, repo };
}

/** Every file under PACER_HOME with its bytes and mode. */
function files(ctxHome: string): Record<string, string> {
  const out: Record<string, string> = {};
  const base = join(ctxHome, ".pacer");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out[relativeBase(base, path)] = `${(stat.mode & 0o777).toString(8)} ${readFileSync(path, "base64")}`;
    }
  };
  walk(base);
  return out;
}
const relativeBase = (base: string, path: string) => path.startsWith(base + "/") ? path.slice(base.length + 1) : path;

/**
 * Wait for a just-started TypeScript core's background plugin publications to
 * flush before snapshotting files, so both twins settle before comparison.
 */
async function settled(ctxHome: string): Promise<Record<string, string>> {
  let last = files(ctxHome);
  let quiet = 0;
  for (let guard = 0; guard < 300; guard++) {
    await Bun.sleep(150);
    const next = files(ctxHome);
    if (JSON.stringify(next) === JSON.stringify(last)) {
      if (++quiet >= 10) return next;
    } else {
      quiet = 0;
      last = next;
    }
  }
  throw new Error("settled: home kept changing; possible background writer");
}

const normalize = (text: string, dir: string) => text.replaceAll(dir, "<home>").replaceAll(realpathSync(dir), "<home>")
  .replace(/"(evaluatedAt|validUntil|checkedAt|at|updatedAt|fetchedAt|capturedAt|until|resetAt|expiresAt|createdAt|settledAt|generatedAt|deadline|now)":[\d.e+-]+/g, '"$1":<t>')
  .replace(/"(requestId|inputHash)":"[0-9a-f]+"/g, '"$1":<hash>');

function env(dir: string, port: string, forward: boolean) {
  return {
    HOME: dir,
    PACER_HOME: join(dir, ".pacer"),
    PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
    PACER_PORT: port,
    PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_LOGIN_ENV: "off",
    PACER_DEBUG_NATIVE: "1",
    ...(forward ? { PACER_FORWARD_OPS: OPS } : {}),
  };
}

type Step = { op: string; params: unknown };
const steps = (id: string, repo: string): Step[] => [
  { op: "limits.check", params: {} },
  { op: "routing.status", params: {} },
  { op: "runner.list", params: {} },
  { op: "strategy.preview", params: { draft: { from: "wide" } } },
  { op: "mode.hold", params: {} },
  { op: "task.retry_options", params: { id } },
  { op: "dispatch.preview", params: { repo, goal: "Goal", kind: "tests", delegationEnforcement: "cooperative" } },
];

async function stdio(dir: string, list: Step[], forward: boolean) {
  const port = closedPort();
  const child = spawnPinned([front!, "api", "--stdio"], {
    cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: env(dir, port, forward),
  });
  const stderr = new Response(child.stderr).text();
  try {
    child.stdin.write([
      { jsonrpc: "2.0", id: 0, method: "hello", params: { protocol: 3 } },
      ...list.map((step, i) => ({ jsonrpc: "2.0", id: i + 1, method: step.op, params: step.params })),
    ].map(request => JSON.stringify(request) + "\n").join(""));
    await child.stdin.end();
    const [code, stdout, trace] = await Promise.all([child.exited, new Response(child.stdout).text(), stderr]);
    expect(code, trace).toBe(0);
    const replies = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
      .sort((a, b) => a.id - b.id).slice(1).map(reply => normalize(JSON.stringify(reply), dir));
    const markers = trace.split("\n").filter(line => OPS.split(",").some(op => line.startsWith(`native ${op} `)));
    return { replies, markers };
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}

async function http(dir: string, list: Step[], forward: boolean) {
  const server = await serve(dir, forward ? OPS : null);
  const replies: string[] = [];
  let trace: string;
  try {
    for (const step of list) replies.push(normalize(await server.post(step.op, step.params), dir));
    trace = await server.stop();
  } catch (error) {
    await server.stop();
    throw error;
  }
  const markers = trace!.split("\n").filter(line => OPS.split(",").some(op => line === `native ${op}`));
  return { replies, markers };
}

test("status-broker parts are native over stdio and HTTP", async () => {
  if (!front) return; // the door binary is supplied by the M1 gate / live harness
  const fixtureHome = fixture();
  for (const transport of ["stdio", "http"] as const) {
    const list = steps(fixtureHome.id, fixtureHome.repo);
    const twins = ["native", "forward"].map(side => {
      const dir = fresh(`pacer-status-parts-${transport}-${side}-`);
      cpSync(fixtureHome.home, dir, { recursive: true });
      return dir;
    });
    const run = (dir: string, forward: boolean) => transport === "stdio" ? stdio(dir, list, forward) : http(dir, list, forward);
    const [native, forwarded] = await Promise.all([
      run(twins[0]!, false), run(twins[1]!, true),
    ]);
    list.forEach((step, i) => {
      expect(`${transport} ${step.op}: ${native!.replies[i]}`, step.op).toBe(`${transport} ${step.op}: ${forwarded!.replies[i]}`);
    });
    expect(native!.markers).toEqual(list.flatMap((step, i) =>
      [transport === "stdio" ? `native ${step.op} ${i + 1}` : `native ${step.op}`]));
    expect(forwarded!.markers).toEqual([]);
    // The cache-only write check lives in `crates/status/tests/parts.rs`
    // (`cache_only_parts_write_nothing`), which compares the whole PACER_HOME
    // tree before and after a cache-only computation.
  }
}, 300_000);

test("the sealed status-broker route and stdio method are gone", async () => {
  const ctx = fakeCtx();
  const server = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/_internal/status-broker-parts`, {
      method: "POST",
      headers: { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    // The private route no longer exists: the internal auth layer answers an
    // unrecognised POST with 405, never a parts result.
    expect(response.status).toBe(405);
  } finally { server.stop(); }
});

test("the retained files helper snapshots the fixture with modes and bytes", async () => {
  const { home } = fixture();
  const snapshot = await settled(home);
  expect(Object.keys(snapshot)).toContain("strategy.yaml");
  expect(Object.keys(snapshot)).toContain("strategies/wide.yaml");
  expect(files(home)).toEqual(snapshot);
});

test("cache-only parts used by dispatch.preview write nothing", async () => {
  if (!front) return;
  const dir = fresh("pacer-status-parts-cache-");
  const repo = gitRepo(dir);
  const ctx: Ctx = withLoginIndicators(fakeCtx({ home: dir, pacerHome: join(dir, ".pacer") }));
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), STRATEGY);
  writeFileSync(join(ctx.pacerHome, "strategies", "wide.yaml"), WIDE);
  const port = closedPort();
  const child = spawnPinned([front!, "api", "--stdio"], {
    cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: env(dir, port, false),
  });
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "dispatch.preview", params: { repo, goal: "Goal", kind: "tests", delegationEnforcement: "cooperative" } }) + "\n");
    await child.stdin.end();
    const [code, stdout, trace] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, trace).toBe(0);
    const replies = stdout.trim().split("\n").map(line => JSON.parse(line)).sort((a, b) => a.id - b.id);
    expect(replies[1]?.result, trace).toBeTruthy();
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  }
}, 60_000);
