/**
 * `host.check` and `host.clean` through the real Rust front doors (`pacer serve`, `pacer api --stdio`) against the real
 * Core in fixtures/host-check-clean-core.ts, with SSH replaced by fixtures/bin/ssh running against a fake host home.
 * Each transport runs the same scenarios natively and with both ops in PACER_FORWARD_OPS, from the same seeded home
 * restored at the same path, so replies and on-disk effects must match byte for byte once job ids, pids and wall
 * times are masked. Refusals and dry runs must never reach Core; admitted HTTP requests must reach it through the
 * host effects bridge, admitted stdio requests as the forwarded operation.
 * Every child, and the core each front door starts, gets PACER_PORT: its own server port or a closed one, never 4317.
 */
import {afterAll, describe, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {join, relative} from "node:path";
import {stringify} from "yaml";
import {createTask, updateTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";
import {closedPort, pinnedEnv} from "./isolated-port";

const CLOSED = String(closedPort());
const CORE = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/host-check-clean-core.ts")]);
const FORWARD = "host.check,host.clean";
const ORIGIN = "https://github.com/o/r.git";
const GRANT = `pwg_${"ab".repeat(32)}`;
const LONG = 600_000;
const HOST_OPS = /^(host\.(check|clean)|_internal\.host\.effects|\/v3\/ops\/host\.(check|clean)|\/_internal\/host-effects)$/;
const TRACED = /native host\.(check|clean)/;

/** Refusals in the reference order: schema, then the unknown host. Bodies are raw HTTP bodies and stdio params. */
const REFUSALS: Array<[string, string]> = [
  ["host.check", '{"alias":"nope"}'],
  ["host.check", '{"alias":"nope","repo":""}'],
  ["host.check", "{}"],
  ["host.check", "[]"],
  ["host.check", "null"],
  ["host.check", `{"alias":"${"x".repeat(129)}"}`],
  ["host.check", '{"alias":"box","repo":7}'],
  ["host.clean", '{"alias":"nope"}'],
  ["host.clean", '{"alias":"nope","dry_run":true}'],
  ["host.clean", '{"alias":"box","dry_run":"yes"}'],
  ["host.clean", '{"alias":"box","dry_run":null}'],
];
const DRY_RUNS = ['{"alias":"box","dry_run":true}', '{"alias":"box","dry_run":true,"extra":1}'];

let binary = process.env.PACER_TEST_NATIVE_FRONT_DOOR ?? "";
function frontDoor() {
  if (!binary) {
    const env = pinnedEnv({...process.env, PACER_PORT: CLOSED});
    execFileSync("cargo", ["build", "-q", "-p", "pacer", "--locked", "--features", "test-ops"], {stdio: "inherit", env});
    const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--locked"], {env}).toString());
    binary = join(metadata.target_directory, "debug/pacer");
  }
  return binary;
}

const roots: string[] = [];
const children: Array<{kill(): void}> = [];
afterAll(() => {
  for (const child of children) child.kill();
  for (const root of roots) rmSync(root, {recursive: true, force: true});
});

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {env: {...process.env, PACER_PORT: CLOSED}}).toString().trim();

function session(home: string, at: number, used: number) {
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, {recursive: true});
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, `${JSON.stringify({timestamp: new Date(at * 1000).toISOString(), payload: {rate_limits: {
    primary: {used_percent: used, window_minutes: 300, resets_in_seconds: 3600},
    secondary: {used_percent: 20, window_minutes: 10080, resets_at: at + 7200},
  }}})}\n`);
  utimesSync(path, at, at);
}

/**
 * A configured host `box` whose SSH runs locally against a fake host home through the real plugins, and four tasks
 * that ran on it: received and mapped (removable), received from an unmapped checkout, never received, and running.
 * The seeded home is saved once; `reset` restores it at the same path, so task ids and paths match between runs.
 */
function world() {
  // host.sock must fit SUN_LEN (~104); bun test's TMPDIR is too deep for native serve.
  const root = mkdtempSync("/tmp/phcc-");
  roots.push(root);
  const home = join(root, "w"), saved = join(root, "saved"), pacerHome = join(home, ".pacer");
  const repo = join(home, "repo"), other = join(home, "other"), checkout = join(home, "checkout"), hostHome = join(home, "host-home"),
    bin = join(home, "bin"), log = join(home, "ssh.log"), down = join(home, "down"), delay = join(home, "delay");
  for (const dir of [repo, other, checkout, hostHome, bin]) mkdirSync(dir, {recursive: true});
  mkdirSync(pacerHome, {mode: 0o700});
  writeFileSync(join(home, "probe"), `__PACER_BEGIN__\ngit=git version 2.40.0\nsetsid=/bin/setsid\nscript=script from util-linux 2.40\ntail=tail (GNU coreutils) 9.5\ntail_pid=1\ncodex=/bin/codex\nclaude=\nhome=${hostHome}\n`);
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nPACER_FAKE_HOST_HOME=${JSON.stringify(hostHome)} PACER_FAKE_SSH_LOG=${JSON.stringify(log)} PACER_FAKE_SSH_DOWN=; export PACER_FAKE_HOST_HOME PACER_FAKE_SSH_LOG PACER_FAKE_SSH_DOWN\n[ ! -e ${JSON.stringify(delay)} ] || sleep 2\n[ ! -e ${JSON.stringify(down)} ] || { echo 'ssh: connection refused' >&2; exit 255; }\ncase "$*" in *"command -v codex"*) cat ${JSON.stringify(join(home, "probe"))}; exit 0;; esac\nexec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  for (const [dir, origin] of [[repo, ORIGIN], [checkout, ORIGIN], [other, "https://github.com/o/other.git"]]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    git(dir, "remote", "add", "origin", origin);
    git(dir, "config", "--local", "user.name", "Test User");
    git(dir, "config", "--local", "user.email", "test@example.invalid");
  }
  const now = Date.now() / 1000;
  session(join(hostHome, ".codex"), now - 20, 45);
  session(join(hostHome, ".codex-team"), now - 30, 60);
  writeFileSync(join(pacerHome, "strategy.yaml"), stringify({
    accounts: {claude: {kind: "claude"}, codex: {kind: "codex"}, team: {kind: "codex", home: "~/.codex-team"}},
    planner: "claude-code", hosts: {box: {ssh: "box-ssh", repos: {"github.com/o/r": checkout}, accounts: {team: {home: "~/.codex-team"}}}},
    routing: [{default: ["codex@box", "codex#team@box", "codex"]}],
  }));
  const ctx = fakeCtx({home, pacerHome});
  const remoteTask = (taskRepo: string, state: "done" | "running", received: boolean) => {
    const t = createTask(ctx, {brief: {goal: "cleanup", repo: taskRepo}, kind: null, requestedExecutor: null, timeoutS: 60});
    const worktree = join(hostHome, ".pacer-remote", "worktrees", "repo-test", `${t.id}-1`), dir = join(hostHome, ".pacer-remote", "runs", t.id, "1");
    mkdirSync(join(hostHome, ".pacer-remote", "worktrees", "repo-test"), {recursive: true});
    git(checkout, "worktree", "add", "-q", "-b", `pacer/${t.id}`, worktree);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, "session.raw"), "recorded output");
    if (received) git(taskRepo, "branch", `pacer/${t.id}`);
    const transferredHead = received ? git(taskRepo, "rev-parse", "HEAD") : undefined;
    updateTask(ctx, t.id, record => {
      record.state = state; if (state === "done") record.dismissed = true;
      record.run = {host: "box", mode: "new", remoteWorktree: worktree, remoteDir: dir, workdir: worktree, dir: "unused", attempt: 1,
        executor: "codex@box", startedAt: 1, logFile: "unused", ...(transferredHead ? {transferredHead} : {})} as never;
    });
    return {id: t.id, worktree, dir};
  };
  const tasks = {
    removable: remoteTask(repo, "done", true),
    unmapped: remoteTask(other, "done", true),
    unreceived: remoteTask(repo, "done", false),
    running: remoteTask(repo, "running", false),
  };
  cpSync(home, saved, {recursive: true, verbatimSymlinks: true});
  return {
    home, pacerHome, repo, other, checkout, hostHome, bin, log, down, delay, tasks,
    reset() {
      rmSync(home, {recursive: true, force: true});
      cpSync(saved, home, {recursive: true, verbatimSymlinks: true});
      chmodSync(pacerHome, 0o700);
    },
    calls: () => existsSync(join(pacerHome, "core-calls.log")) ? readFileSync(join(pacerHome, "core-calls.log"), "utf8").trim().split("\n") : [],
  };
}
type World = ReturnType<typeof world>;

/** Job ids, pids and wall times differ per run; every other byte must match. */
function mask(text: string) {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/("pid":)\d+/g, '$1"<pid>"')
    .replace(/(":)(1[5-9]\d{8}|[2-4]\d{9})(\.\d+)?(?=[,}\]])/g, '$1"<time>"')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<iso>");
}

function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter(entry => !entry.isDirectory())
    .map(entry => relative(dir, join(entry.parentPath, entry.name))).sort();
}

/** Jobs, host checks, the remote usage cache, task records, the fake host's files, SSH calls and local branches. */
function state(w: World) {
  const read = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const jsonDir = (dir: string) => tree(dir).filter(name => name.endsWith(".json")).map(name => [name, read(join(dir, name))]);
  return mask(JSON.stringify({
    // Job file names are random ids; order the masked records instead.
    jobs: jsonDir(join(w.pacerHome, "state", "jobs")).map(([, job]) => mask(JSON.stringify(job))).sort(),
    hostChecks: read(join(w.pacerHome, "state", "host-checks.json")),
    usage: jsonDir(join(w.pacerHome, "cache", "remote-usage")),
    tasks: jsonDir(join(w.pacerHome, "tasks")),
    host: tree(w.hostHome),
    ssh: existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter(Boolean).length : 0,
    branches: [git(w.repo, "branch", "--list"), git(w.other, "branch", "--list")],
  }));
}

function sandboxEnv(w: World, forward: string | undefined, extra: Record<string, string>) {
  return pinnedEnv({
    HOME: w.home, PACER_HOME: w.pacerHome, PATH: `${w.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, PACER_CORE_ARGV: CORE,
    PACER_BACKEND: "direct", PACER_ORCA_USER_DATA: join(w.home, "orca"), PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", PACER_PORT: CLOSED, ...(forward ? {PACER_FORWARD_OPS: forward} : {}), ...extra,
  });
}

function drain(stream: ReadableStream<Uint8Array>) {
  const sink = {text: "", done: Promise.resolve()};
  sink.done = (async () => { const decoder = new TextDecoder(); for await (const chunk of stream) sink.text += decoder.decode(chunk, {stream: true}); })();
  return sink;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address() as {port: number};
      server.close(() => resolve(port));
    });
  });
}

async function serve(w: World, forward?: string) {
  const port = await freePort();
  const env = sandboxEnv(w, forward, {PACER_PORT: String(port)});
  const child = Bun.spawn([frontDoor(), "serve", "--port", String(port)], {env, cwd: w.home, stdout: "ignore", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  await until(() => existsSync(join(w.pacerHome, "core-ready")) && existsSync(join(w.pacerHome, "token")), "pacer serve and its core");
  const token = readFileSync(join(w.pacerHome, "token"), "utf8").trim();
  const raw = async (op: string, body: string, headers: Record<string, string> = {authorization: `Bearer ${token}`}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v3/ops/${op}`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body});
    return {status: response.status, type: response.headers.get("content-type"), body: await response.text()};
  };
  return {stderr, raw, stop: async () => { child.kill(); await child.exited; await stderr.done; }};
}

function connect(w: World, forward?: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([frontDoor(), "api", "--stdio"], {env: sandboxEnv(w, forward, extra), cwd: w.home, stdin: "pipe", stdout: "pipe", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  const waiting = new Map<number, (line: string) => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, {stream: true});
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const id = line ? JSON.parse(line).id : undefined;
        if (typeof id === "number") waiting.get(id)?.(line);
      }
    }
  })();
  let next = 1;
  /** The reply line exactly as the front door wrote it; `params` is raw JSON text. */
  const call = (method: string, params = "{}") => {
    const id = next++;
    const reply = new Promise<string>(resolve => waiting.set(id, resolve));
    child.stdin.write(`{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${params}}\n`);
    child.stdin.flush();
    return reply;
  };
  return {stderr, call, close: async () => { child.stdin.end(); await child.exited; await stderr.done; }};
}

/** Each dry-run row by branch; rows list newest task first, and ids created in one second sort randomly. */
const fates = (reply: string) => Object.fromEntries((JSON.parse(reply).result.worktrees as Array<{branch: string; state: string; fate: string}>)
  .map(row => [row.branch, `${row.state} ${row.fate}`]));
const expectedFates = ({tasks}: World) => ({
  [`pacer/${tasks.removable.id}`]: "done will remove", [`pacer/${tasks.unmapped.id}`]: "done kept",
  [`pacer/${tasks.unreceived.id}`]: "done kept", [`pacer/${tasks.running.id}`]: "running in use",
});

/** Runs `check` with the host checkout's identity changed, then with the checkout missing; restores both. */
async function brokenCheckouts<T>(w: World, check: () => Promise<T>) {
  git(w.checkout, "config", "--local", "user.email", "someone@example.invalid");
  const identity = await check();
  git(w.checkout, "config", "--local", "user.email", "test@example.invalid");
  renameSync(w.checkout, `${w.checkout}.moved`);
  const missing = await check();
  renameSync(`${w.checkout}.moved`, w.checkout);
  return {identity, missing};
}

/** Host-op paths and methods that reached Core, in order. */
const hostCalls = (w: World) => w.calls().filter(call => HOST_OPS.test(call));

describe("HTTP front door", () => {
  async function scenarios(w: World, forward?: string) {
    w.reset();
    const server = await serve(w, forward);
    const out: Record<string, unknown> = {};
    const job = async (op: string, body: string) => {
      const reply = await server.raw(op, body);
      const parsed = JSON.parse(reply.body);
      expect(parsed.result?.job?.state, reply.body).toBe("running");
      const id = parsed.result.job.id;
      let settled = "";
      await until(async () => {
        settled = (await server.raw("job.get", JSON.stringify({id}))).body;
        return JSON.parse(settled).result?.state !== "running";
      }, `${op} job`);
      return {reply: {...reply, body: mask(reply.body)}, settled: mask(settled)};
    };
    out.refusals = [];
    for (const [op, body] of REFUSALS) (out.refusals as unknown[]).push(await server.raw(op, body));
    const before = state(w);
    out.dryRuns = [];
    for (const body of DRY_RUNS) (out.dryRuns as unknown[]).push(await server.raw("host.clean", body));
    out.dryRunWroteNothing = state(w) === before;
    out.check = await job("host.check", JSON.stringify({alias: "box", repo: w.repo}));
    out.unmapped = await server.raw("host.check", JSON.stringify({alias: "box", repo: w.other}));
    out.notRepo = await server.raw("host.check", JSON.stringify({alias: "box", repo: join(w.home, "missing")}));

    writeFileSync(w.delay, "");
    const first = JSON.parse((await server.raw("host.check", '{"alias":"box"}')).body).result.job;
    const second = JSON.parse((await server.raw("host.check", '{"alias":"box"}')).body).result.job;
    out.dedupe = {same: first.id === second.id, kind: second.kind, target: second.target, state: second.state};
    rmSync(w.delay);
    await until(async () => JSON.parse((await server.raw("job.get", JSON.stringify({id: first.id}))).body).result.state !== "running", "the deduplicated check");

    writeFileSync(w.down, "");
    out.unreachable = await job("host.check", JSON.stringify({alias: "box", repo: w.repo}));
    rmSync(w.down);
    out.checkouts = await brokenCheckouts(w, () => job("host.check", JSON.stringify({alias: "box", repo: w.repo})));
    out.clean = await job("host.clean", '{"alias":"box"}');
    out.grant = await server.raw("host.check", '{"alias":"box"}', {authorization: `Bearer ${GRANT}`});
    out.state = state(w);
    await server.stop();
    return {out, trace: server.stderr.text, calls: hostCalls(w)};
  }

  test("replies and effects match the forwarded path; only admitted requests reach Core, through the bridge", async () => {
    const w = world();
    const native = await scenarios(w);
    const forwarded = await scenarios(w, FORWARD);
    expect(native.out).toEqual(forwarded.out);

    expect(native.trace).toContain("native host.check");
    expect(native.trace).toContain("native host.clean");
    expect(forwarded.trace).not.toMatch(TRACED);
    const bridge = "/_internal/host-effects";
    // check, unmapped, missing local repo, two deduplicated checks, unreachable, two broken host checkouts, clean;
    // then the work grant, forwarded.
    expect(native.calls).toEqual([...Array(9).fill(bridge), "/v3/ops/host.check"]);
    expect(forwarded.calls).not.toContain(bridge);
    expect(forwarded.calls.filter(call => call === "/v3/ops/host.clean")).toHaveLength(REFUSALS.filter(([op]) => op === "host.clean").length + DRY_RUNS.length + 1);

    const r = native.out as Record<string, any>;
    const errors = (r.refusals as Array<{status: number; body: string}>).map(reply => [reply.status, JSON.parse(reply.body).error]);
    expect(errors).toEqual([
      [400, {code: "invalid_input", message: "unknown host nope"}],
      [400, {code: "invalid_input", message: "repo: Too small: expected string to have >=1 characters"}],
      [400, {code: "invalid_input", message: "alias: Invalid input: expected string, received undefined"}],
      [400, {code: "invalid_input", message: "params: Invalid input: expected object, received array"}],
      [400, {code: "invalid_input", message: "alias: Invalid input: expected string, received undefined"}],
      [400, {code: "invalid_input", message: "alias: Too big: expected string to have <=128 characters"}],
      [400, {code: "invalid_input", message: "repo: Invalid input: expected string, received number"}],
      [400, {code: "invalid_input", message: "unknown host nope"}],
      [400, {code: "invalid_input", message: "unknown host nope"}],
      [400, {code: "invalid_input", message: "dry_run: Invalid input: expected boolean, received string"}],
      [400, {code: "invalid_input", message: "dry_run: Invalid input: expected boolean, received null"}],
    ]);
    const {tasks} = w;
    expect(fates(r.dryRuns[0].body)).toEqual(expectedFates(w));
    expect(r.dryRuns[1]).toEqual(r.dryRuns[0]);
    expect(r.dryRunWroteNothing).toBe(true);
    expect(JSON.parse(r.check.settled).result).toMatchObject({kind: "host.check", target: "box", state: "passed"});
    expect(JSON.parse(r.unmapped.body).error).toEqual({code: "invalid_input", message: "repo not mapped on box"});
    expect(r.dedupe).toEqual({same: true, kind: "host.check", target: "box", state: "running"});
    expect(JSON.parse(r.unreachable.settled).result).toMatchObject({kind: "host.check", state: "failed"});
    for (const broken of [r.checkouts.identity, r.checkouts.missing]) {
      expect(JSON.parse(broken.settled).result).toMatchObject({kind: "host.check", state: "failed"});
    }
    expect(JSON.parse(r.clean.settled).result).toMatchObject({kind: "host.clean", target: "box"});
    expect(r.grant.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(tasks.removable.worktree)).toBe(false);
    expect(existsSync(tasks.unmapped.worktree)).toBe(true);
  }, LONG);
});

describe("stdio front door", () => {
  async function scenarios(w: World, forward?: string) {
    w.reset();
    const out: Record<string, unknown> = {};
    const rpc = connect(w, forward);
    await rpc.call("hello", '{"protocol":3}');
    out.refusals = [];
    for (const [op, params] of REFUSALS) (out.refusals as unknown[]).push(await rpc.call(op, params));
    const before = state(w);
    out.dryRuns = [];
    for (const params of DRY_RUNS) (out.dryRuns as unknown[]).push(await rpc.call("host.clean", params));
    out.dryRunWroteNothing = state(w) === before;
    out.check = mask(await rpc.call("host.check", JSON.stringify({alias: "box", repo: w.repo})));
    out.unmapped = await rpc.call("host.check", JSON.stringify({alias: "box", repo: w.other}));
    writeFileSync(w.down, "");
    out.unreachable = mask(await rpc.call("host.check", JSON.stringify({alias: "box", repo: w.repo})));
    rmSync(w.down);
    out.checkouts = await brokenCheckouts(w, async () => mask(await rpc.call("host.check", JSON.stringify({alias: "box", repo: w.repo}))));
    out.clean = mask(await rpc.call("host.clean", '{"alias":"box"}'));
    await rpc.close();

    const sessions: string[] = [rpc.stderr.text];
    for (const env of [{PACER_ENFORCEMENT_TOKEN: "t"}, {PACER_WORK_GRANT: GRANT}] as Record<string, string>[]) {
      const scoped = connect(w, forward, env);
      await scoped.call("hello", '{"protocol":3}');
      out[Object.keys(env)[0]] = [await scoped.call("host.check", '{"alias":"box"}'), await scoped.call("host.clean", DRY_RUNS[0])];
      await scoped.close();
      sessions.push(scoped.stderr.text);
    }
    out.state = state(w);
    return {out, sessions, calls: hostCalls(w)};
  }

  test("reply lines and effects match the forwarded path; refusals and dry runs never reach Core", async () => {
    const w = world();
    const native = await scenarios(w);
    const forwarded = await scenarios(w, FORWARD);
    expect(native.out).toEqual(forwarded.out);

    const [operator, enforced, granted] = native.sessions;
    expect(operator).toContain("native host.check");
    expect(operator).toContain("native host.clean");
    expect(enforced).toContain("native host.check");
    expect(granted).not.toMatch(TRACED);
    for (const trace of forwarded.sessions) expect(trace).not.toMatch(TRACED);
    // Admitted requests are forwarded unchanged: check, unmapped, unreachable, two broken host checkouts, clean; then
    // the work-grant session.
    expect(native.calls).toEqual([...Array(5).fill("host.check"), "host.clean", "host.check", "host.clean"]);
    expect(forwarded.calls.filter(call => call === "host.check")).toHaveLength(REFUSALS.filter(([op]) => op === "host.check").length + 5 + 2);

    const r = native.out as Record<string, any>;
    for (const [i, line] of (r.refusals as string[]).entries()) expect(JSON.parse(line).error.data.code, REFUSALS[i]!.join(" ")).toBe("invalid_input");
    const {tasks} = w;
    expect(fates(r.dryRuns[0])).toEqual(expectedFates(w));
    expect(JSON.parse(r.dryRuns[1]).result).toEqual(JSON.parse(r.dryRuns[0]).result);
    expect(r.dryRunWroteNothing).toBe(true);
    expect(JSON.parse(r.check).result.job).toMatchObject({kind: "host.check", target: "box", state: "passed"});
    expect(JSON.parse(r.unmapped).error).toMatchObject({message: "repo not mapped on box", data: {code: "invalid_input"}});
    expect(JSON.parse(r.unreachable).result.job).toMatchObject({kind: "host.check", state: "failed"});
    for (const broken of [r.checkouts.identity, r.checkouts.missing]) {
      expect(JSON.parse(broken).result.job).toMatchObject({kind: "host.check", state: "failed"});
    }
    expect(JSON.parse(r.clean).result.job).toMatchObject({kind: "host.clean", target: "box"});
    for (const line of r.PACER_ENFORCEMENT_TOKEN as string[]) {
      expect(JSON.parse(line).error).toMatchObject({message: "Enforcement identity only reports a native child denial", data: {code: "not_allowed"}});
    }
    for (const line of r.PACER_WORK_GRANT as string[]) expect(JSON.parse(line).error).toBeDefined();
    expect(existsSync(tasks.removable.worktree)).toBe(false);
    expect(existsSync(tasks.unmapped.worktree)).toBe(true);
  }, LONG);
});
