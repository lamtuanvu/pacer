/**
 * `host.repo.setup` through the real Rust front doors (`pacer serve`, `pacer api --stdio`) against the real Core in
 * fixtures/host-check-clean-core.ts, with SSH replaced by fixtures/bin/ssh running against a fake host home and the
 * clone URL rewritten to a local repository (git may use only the file protocol, so nothing reaches the network).
 * Each transport runs the same scenarios natively and with the op in PACER_FORWARD_OPS, from the same seeded home
 * restored at the same path, so replies and on-disk effects must match byte for byte once job ids, pids and wall
 * times are masked. Consent, schema, unknown-host and repo-not-mapped refusals must never reach Core; admitted HTTP
 * requests must reach it through the host effects bridge, admitted stdio requests as the forwarded operation.
 * Every child, and the core each front door starts, gets PACER_PORT: its own server port or a closed one, never 4317.
 */
import {afterAll, describe, expect, test} from "bun:test";
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {join, relative} from "node:path";
import {stringify} from "yaml";
import {createSession} from "../src/serve/app-auth";
import {createTask} from "../src/tasks/store";
import {fakeCtx} from "./helpers";
import {closedPort, pinnedEnv} from "./isolated-port";

const CLOSED = String(closedPort());
const CORE = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/host-check-clean-core.ts")]);
const FORWARD = "host.repo.setup";
const ORIGIN = "https://github.com/o/r.git";
const KEY = "github.com/o/r";
const GRANT = `pwg_${"ab".repeat(32)}`;
const LONG = 600_000;
const SETUP_CALLS = /^(host\.repo\.setup|_internal\.host\.effects|\/v3\/ops\/host\.repo\.setup|\/_internal\/host-effects)$/;
const TRACED = /native host\.repo\.setup/;
const CONSENT = "consent: Invalid input: expected true";
const NOT_MAPPED = {code: "invalid_input", message: "repo not mapped on box", hint: "Use a mapped canonical host/owner/repo key."};

/** Refusals in the reference order: schema (consent included), then the unknown host, then the key. */
const REFUSALS: Array<[string, unknown]> = [
  [`{"alias":"box","key":"${KEY}"}`, {code: "invalid_input", message: CONSENT}],
  [`{"alias":"box","key":"${KEY}","consent":false}`, {code: "invalid_input", message: CONSENT}],
  [`{"alias":"box","key":"${KEY}","consent":"true"}`, {code: "invalid_input", message: CONSENT}],
  [`{"alias":"box","key":"${KEY}","consent":1}`, {code: "invalid_input", message: CONSENT}],
  [`{"alias":"box","key":"${KEY}","consent":null}`, {code: "invalid_input", message: CONSENT}],
  [`{"alias":"nope","key":"${KEY}"}`, {code: "invalid_input", message: CONSENT}],
  ["{}", {code: "invalid_input", message: `alias: Invalid input: expected string, received undefined; key: Invalid input: expected string, received undefined; ${CONSENT}`}],
  ["null", {code: "invalid_input", message: `alias: Invalid input: expected string, received undefined; key: Invalid input: expected string, received undefined; ${CONSENT}`}],
  ["[]", {code: "invalid_input", message: "params: Invalid input: expected object, received array"}],
  [`{"alias":"box","key":"","clone":"yes","identity":null,"consent":true}`, {code: "invalid_input", message: "key: Too small: expected string to have >=1 characters; clone: Invalid input: expected boolean, received string; identity: Invalid input: expected boolean, received null"}],
  [`{"alias":"${"x".repeat(129)}","key":"${KEY}","consent":true}`, {code: "invalid_input", message: "alias: Too big: expected string to have <=128 characters"}],
  [`{"alias":"nope","key":"${KEY}","consent":true}`, {code: "invalid_input", message: "unknown host nope"}],
  [`{"alias":"box","key":"github.com/o/other","consent":true}`, NOT_MAPPED],
  [`{"alias":"box","key":"not-canonical","consent":true}`, NOT_MAPPED],
  [`{"alias":"box","key":"${KEY}.git","consent":true}`, NOT_MAPPED],
];
const setup = (extra: Record<string, unknown> = {}) => JSON.stringify({alias: "box", key: KEY, consent: true, ...extra});

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

const gitEnv = {...process.env, PACER_PORT: CLOSED, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1"};
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], {env: gitEnv}).toString().trim();
const gitRead = (dir: string, ...args: string[]) => { try { return git(dir, ...args); } catch { return null; } };

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
 * A configured host `box` whose SSH runs locally against a fake host home through the real plugins. `box` maps
 * `github.com/o/r` to `~/src/r`, not yet cloned, and `github.com/o/gone`, which has no local checkout. A task records
 * the local checkout of `github.com/o/r`, which is where setup finds it. The seeded home is saved once; `reset`
 * restores it at the same path, so task ids and paths match between runs.
 */
function world() {
  // host.sock must fit SUN_LEN (~104); bun test's TMPDIR is too deep for native serve.
  const root = mkdtempSync("/tmp/phrs-");
  roots.push(root);
  const home = join(root, "w"), saved = join(root, "saved"), pacerHome = join(home, ".pacer");
  const repo = join(home, "repo"), hostHome = join(home, "host-home"), checkout = join(hostHome, "src", "r"), bin = join(home, "bin"),
    log = join(home, "ssh.log"), down = join(home, "down"), delay = join(home, "delay"), noclone = join(home, "noclone");
  for (const dir of [repo, join(hostHome, ".codex-team"), bin]) mkdirSync(dir, {recursive: true});
  mkdirSync(pacerHome, {mode: 0o700});
  writeFileSync(join(home, "probe"), `__PACER_BEGIN__\ngit=git version 2.40.0\nsetsid=/bin/setsid\nscript=script from util-linux 2.40\ntail=tail (GNU coreutils) 9.5\ntail_pid=1\ncodex=/bin/codex\nclaude=\nhome=${hostHome}\n`);
  const q = JSON.stringify;
  writeFileSync(join(bin, "ssh"), [
    "#!/bin/sh",
    `PACER_FAKE_HOST_HOME=${q(hostHome)} PACER_FAKE_SSH_LOG=${q(log)} PACER_FAKE_SSH_DOWN=; export PACER_FAKE_HOST_HOME PACER_FAKE_SSH_LOG PACER_FAKE_SSH_DOWN`,
    "GIT_ALLOW_PROTOCOL=file; export GIT_ALLOW_PROTOCOL",
    `source=${q(repo)}; [ ! -e ${q(noclone)} ] || source=${q(join(home, "no-such-remote"))}`,
    `[ ! -e ${q(delay)} ] || sleep 2`,
    `[ ! -e ${q(down)} ] || { echo 'ssh: connection refused' >&2; exit 255; }`,
    // Only the clone reads the rewrite; the checkout keeps the configured origin for the Check step.
    `case "$*" in *"command -v codex"*) cat ${q(join(home, "probe"))}; exit 0;; *" clone ${ORIGIN}") GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$source.insteadOf" GIT_CONFIG_VALUE_0=${q(ORIGIN)}; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0;; esac`,
    `exec ${q(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "ssh"), 0o755);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git(repo, "remote", "add", "origin", ORIGIN);
  git(repo, "config", "--local", "user.name", "Test User");
  git(repo, "config", "--local", "user.email", "test@example.invalid");
  const now = Date.now() / 1000;
  session(join(hostHome, ".codex"), now - 20, 45);
  session(join(hostHome, ".codex-team"), now - 30, 60);
  const strategy = (paused: boolean) => stringify({
    accounts: {claude: {kind: "claude"}, codex: {kind: "codex"}, team: {kind: "codex", home: "~/.codex-team"}},
    planner: "claude-code",
    hosts: {box: {ssh: "box-ssh", ...(paused ? {paused} : {}), repos: {[KEY]: "~/src/r", "github.com/o/gone": "~/src/gone"}, accounts: {team: {home: "~/.codex-team"}}}},
    routing: [{default: ["codex@box", "codex#team@box", "codex"]}],
  });
  writeFileSync(join(pacerHome, "strategy.yaml"), strategy(false));
  const ctx = fakeCtx({home, pacerHome});
  createTask(ctx, {brief: {goal: "setup", repo}, kind: null, requestedExecutor: null, timeoutS: 60});
  const cookie = createSession(fakeCtx({home, pacerHome, now: Date.now() / 1000}));
  cpSync(home, saved, {recursive: true, verbatimSymlinks: true});
  return {
    home, pacerHome, repo, hostHome, checkout, log, down, delay, noclone, cookie,
    reset() {
      rmSync(home, {recursive: true, force: true});
      cpSync(saved, home, {recursive: true, verbatimSymlinks: true});
      chmodSync(pacerHome, 0o700);
    },
    pause(paused: boolean) { writeFileSync(join(pacerHome, "strategy.yaml"), strategy(paused)); },
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

/** The host checkout as setup leaves it: present, its origin and its repo-local identity. */
function hostCheckout(w: World) {
  if (!existsSync(w.checkout)) return null;
  return {
    origin: gitRead(w.checkout, "remote", "get-url", "origin"),
    name: gitRead(w.checkout, "config", "--local", "user.name"),
    email: gitRead(w.checkout, "config", "--local", "user.email"),
    head: gitRead(w.checkout, "rev-parse", "HEAD") === git(w.repo, "rev-parse", "HEAD"),
  };
}

/** Jobs, host checks, the remote usage cache, the strategy file, the fake host's files and checkout, and SSH calls. */
function state(w: World) {
  const read = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const jsonDir = (dir: string) => tree(dir).filter(name => name.endsWith(".json")).map(name => [name, read(join(dir, name))]);
  return mask(JSON.stringify({
    // Job file names are random ids; order the masked records instead.
    jobs: jsonDir(join(w.pacerHome, "state", "jobs")).map(([, job]) => mask(JSON.stringify(job))).sort(),
    hostChecks: read(join(w.pacerHome, "state", "host-checks.json")),
    usage: jsonDir(join(w.pacerHome, "cache", "remote-usage")),
    strategy: readFileSync(join(w.pacerHome, "strategy.yaml"), "utf8"),
    host: tree(w.hostHome),
    checkout: hostCheckout(w),
    ssh: existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter(Boolean).length : 0,
  }));
}

function sandboxEnv(w: World, forward: string | undefined, extra: Record<string, string>) {
  return pinnedEnv({
    HOME: w.home, PACER_HOME: w.pacerHome, PATH: `${join(w.home, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, PACER_CORE_ARGV: CORE,
    PACER_BACKEND: "direct", PACER_ORCA_USER_DATA: join(w.home, "orca"), PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", PACER_PORT: CLOSED, ...(forward ? {PACER_FORWARD_OPS: forward} : {}), ...extra,
  });
}

function drain(stream: ReadableStream<Uint8Array>) {
  const sink = {text: "", done: Promise.resolve()};
  sink.done = (async () => { const decoder = new TextDecoder(); for await (const chunk of stream) sink.text += decoder.decode(chunk, {stream: true}); })();
  return sink;
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 60_000) {
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

async function serve(w: World, forward?: string, extra: Record<string, string> = {}) {
  const port = await freePort();
  const env = sandboxEnv(w, forward, {PACER_PORT: String(port), ...extra});
  const child = Bun.spawn([frontDoor(), "serve", "--port", String(port)], {env, cwd: w.home, stdout: "ignore", stderr: "pipe"});
  children.push(child);
  const stderr = drain(child.stderr);
  await until(() => existsSync(join(w.pacerHome, "core-ready")) && existsSync(join(w.pacerHome, "token")), "pacer serve and its core");
  const token = readFileSync(join(w.pacerHome, "token"), "utf8").trim();
  const raw = async (op: string, body: string, headers: Record<string, string> = {authorization: `Bearer ${token}`}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v3/ops/${op}`, {method: "POST", headers: {"content-type": "application/json", ...headers}, body});
    return {status: response.status, type: response.headers.get("content-type"), body: await response.text()};
  };
  /** An app (cookie session) caller. */
  const app = {cookie: `pacer_session=${w.cookie}`, origin: `http://127.0.0.1:${port}`, "x-pacer-client": "app"};
  return {stderr, raw, app, stop: async () => { child.kill(); await child.exited; await stderr.done; }};
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

/**
 * Admitted setups in order, each followed by the host checkout it leaves: a missing local checkout (Core's error), a
 * fresh clone, an existing checkout with a changed identity, identity only, clone only (the identity stays changed), a
 * mixed-case key, a clone that fails, an unreachable host, a paused host (the clone issuer refuses), and a local repo
 * with no email. `run` sends one request and returns its settled job or error.
 */
async function admitted(w: World, run: (body: string) => Promise<unknown>) {
  const out: Record<string, unknown> = {};
  const step = async (name: string, body: string) => { out[name] = {reply: await run(body), checkout: hostCheckout(w)}; };
  const changeIdentity = () => git(w.checkout, "config", "--local", "user.email", "someone@example.invalid");
  await step("notFound", JSON.stringify({alias: "box", key: "github.com/o/gone", consent: true}));
  await step("cloned", setup());
  changeIdentity();
  await step("existing", setup());
  changeIdentity();
  await step("identityOnly", setup({clone: false}));
  changeIdentity();
  await step("cloneOnly", setup({identity: false}));
  await step("mixedCase", JSON.stringify({alias: "box", key: "GitHub.com/O/R", consent: true}));
  rmSync(w.checkout, {recursive: true, force: true});
  writeFileSync(w.noclone, "");
  await step("cloneFailed", setup());
  rmSync(w.noclone);
  writeFileSync(w.down, "");
  await step("unreachable", setup());
  rmSync(w.down);
  w.pause(true);
  await step("paused", setup());
  w.pause(false);
  git(w.repo, "config", "--local", "--unset", "user.email");
  await step("noEmail", setup({clone: false}));
  git(w.repo, "config", "--local", "user.email", "test@example.invalid");
  return out;
}

/** Setup-op paths and methods that reached Core, in order. */
const setupCalls = (w: World) => w.calls().filter(call => SETUP_CALLS.test(call));
const ADMITTED = 10;

function expectAdmitted(r: Record<string, any>, job: (reply: unknown) => any) {
  const steps = (name: string) => job(r[name].reply).steps.map((s: {name: string; state: string; detail?: string}) => [s.name, s.state, s.detail ?? ""]);
  const restored = {origin: ORIGIN, name: "Test User", email: "test@example.invalid", head: true};
  expect(r.notFound.checkout).toBeNull();
  expect(r.cloned.checkout).toEqual(restored);
  expect(job(r.cloned.reply)).toMatchObject({kind: "host.repo.setup", target: `box:${KEY}`, state: "passed"});
  expect(steps("cloned")).toEqual([["Clone", "passed", ""], ["Set identity", "passed", ""], ["Check", "passed", ""]]);
  expect(steps("existing")[0]).toEqual(["Clone", "skipped", "checkout already exists"]);
  expect(job(r.existing.reply).state).toBe("passed");
  expect(r.existing.checkout).toEqual(restored);
  expect(steps("identityOnly")).toEqual([["Clone", "skipped", ""], ["Set identity", "passed", ""], ["Check", "passed", ""]]);
  expect(r.identityOnly.checkout).toEqual(restored);
  expect(steps("cloneOnly").slice(0, 2)).toEqual([["Clone", "skipped", "checkout already exists"], ["Set identity", "skipped", ""]]);
  expect(job(r.cloneOnly.reply).state).toBe("failed");
  expect(r.cloneOnly.checkout.email).toBe("someone@example.invalid");
  expect(job(r.mixedCase.reply)).toMatchObject({target: `box:${KEY}`, state: "passed"});
  expect(job(r.cloneFailed.reply)).toMatchObject({state: "failed", error: {code: "invalid_input", message: "clone failed on box"}});
  expect(r.cloneFailed.checkout).toBeNull();
  expect(job(r.unreachable.reply)).toMatchObject({state: "failed", error: {code: "invalid_input", message: "host box unreachable"}});
  expect(job(r.paused.reply)).toMatchObject({state: "failed", error: {code: "capability_denied", message: "configured host clone changed or was not issued"}});
  expect(r.paused.checkout).toBeNull();
  expect(job(r.noEmail.reply)).toMatchObject({state: "failed", error: {code: "invalid_input", message: "local repo needs user.name and user.email"}});
}

describe("HTTP front door", () => {
  async function scenarios(w: World, forward?: string) {
    w.reset();
    const server = await serve(w, forward);
    const out: Record<string, unknown> = {};
    const settle = async (body: string, headers?: Record<string, string>) => {
      const reply = await server.raw("host.repo.setup", body, headers);
      const id = JSON.parse(reply.body).result?.job?.id;
      if (!id) return {...reply, body: mask(reply.body)};
      expect(JSON.parse(reply.body).result.job.state, reply.body).toBe("running");
      let settled = "";
      await until(async () => {
        settled = (await server.raw("job.get", JSON.stringify({id}))).body;
        const {result} = JSON.parse(settled);
        if (!result) throw new Error(`job.get ${id}: ${settled}`);
        return result.state !== "running";
      }, "the setup job");
      return {reply: {...reply, body: mask(reply.body)}, settled: mask(settled)};
    };
    out.refusals = [];
    for (const [body] of REFUSALS) (out.refusals as unknown[]).push(await server.raw("host.repo.setup", body));
    out.appRefusals = [await server.raw("host.repo.setup", `{"alias":"box","key":"${KEY}"}`, server.app),
      await server.raw("host.repo.setup", `{"alias":"box","key":"github.com/o/other","consent":true}`, server.app)];
    out.refusedState = state(w);
    out.admitted = await admitted(w, body => settle(body));
    // The failure steps left no host checkout; the app caller clones it again.
    out.app = await settle(setup(), server.app);
    writeFileSync(w.delay, "");
    const first = JSON.parse((await server.raw("host.repo.setup", setup({clone: false}))).body).result.job;
    const second = JSON.parse((await server.raw("host.repo.setup", setup({clone: false}))).body).result.job;
    out.dedupe = {same: first.id === second.id, kind: second.kind, target: second.target, state: second.state};
    rmSync(w.delay);
    await until(async () => JSON.parse((await server.raw("job.get", JSON.stringify({id: first.id}))).body).result.state !== "running", "the deduplicated setup");
    out.grant = await server.raw("host.repo.setup", setup(), {authorization: `Bearer ${GRANT}`});
    out.state = state(w);
    await server.stop();
    return {out, trace: server.stderr.text, calls: setupCalls(w)};
  }

  /** A serve process whose environment carries the enforcement identity, called by the operator bearer and an app session. */
  async function enforced(w: World, forward?: string) {
    w.reset();
    const server = await serve(w, forward, {PACER_ENFORCEMENT_TOKEN: "t"});
    const replies = [];
    for (const headers of [undefined, server.app]) {
      for (const body of [setup(), `{"alias":"box","key":"${KEY}"}`]) replies.push(await server.raw("host.repo.setup", body, headers));
    }
    const out = {replies, state: state(w)};
    await server.stop();
    return {out, trace: server.stderr.text, calls: setupCalls(w)};
  }

  test("replies and effects match the forwarded path; only admitted requests reach Core, through the bridge", async () => {
    const w = world();
    const enforcement = {native: await enforced(w), forwarded: await enforced(w, FORWARD)};
    expect(enforcement.native.out).toEqual(enforcement.forwarded.out);
    for (const reply of enforcement.native.out.replies) {
      expect([reply.status, JSON.parse(reply.body).error]).toEqual([403, {code: "not_allowed", message: "Enforcement identity only reports a native child denial"}]);
    }
    expect(enforcement.native.trace).toMatch(TRACED);
    expect(enforcement.native.calls).toEqual([]);
    expect(enforcement.forwarded.trace).not.toMatch(TRACED);
    expect(enforcement.forwarded.calls).toEqual(Array(4).fill("/v3/ops/host.repo.setup"));

    const native = await scenarios(w);
    const forwarded = await scenarios(w, FORWARD);
    expect(native.out).toEqual(forwarded.out);

    expect(native.trace).toMatch(TRACED);
    expect(forwarded.trace).not.toMatch(TRACED);
    const bridge = "/_internal/host-effects";
    // The admitted setups, the app setup and two deduplicated setups; then the work grant, forwarded.
    expect(native.calls).toEqual([...Array(ADMITTED + 3).fill(bridge), "/v3/ops/host.repo.setup"]);
    expect(forwarded.calls).toEqual(Array(REFUSALS.length + 2 + ADMITTED + 3 + 1).fill("/v3/ops/host.repo.setup"));

    const r = native.out as Record<string, any>;
    expect((r.refusals as Array<{status: number; body: string}>).map(reply => [reply.status, JSON.parse(reply.body).error]))
      .toEqual(REFUSALS.map(([, error]) => [400, error]));
    expect((r.appRefusals as Array<{body: string}>).map(reply => JSON.parse(reply.body).error)).toEqual([{code: "invalid_input", message: CONSENT}, NOT_MAPPED]);
    expect(JSON.parse(r.refusedState).jobs).toEqual([]);
    expect(JSON.parse(r.refusedState).checkout).toBeNull();
    const notFound = r.admitted.notFound.reply;
    expect([notFound.status, JSON.parse(notFound.body).error]).toEqual([400, {code: "invalid_input", message: "local repo checkout not found",
      hint: "Run pacer host setup from the local checkout, or delegate a task for that repo first."}]);
    expectAdmitted(r.admitted, reply => JSON.parse((reply as {settled: string}).settled).result);
    expect(JSON.parse(r.app.settled).result).toMatchObject({kind: "host.repo.setup", state: "passed",
      steps: [{name: "Clone", state: "passed"}, {name: "Set identity", state: "passed"}, {name: "Check", state: "passed"}]});
    expect(r.dedupe).toEqual({same: true, kind: "host.repo.setup", target: `box:${KEY}`, state: "running"});
    expect(r.grant.status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(r.state).hostChecks.box.ok).toBe(true);
  }, LONG);
});

describe("stdio front door", () => {
  async function scenarios(w: World, forward?: string) {
    w.reset();
    const out: Record<string, unknown> = {};
    const rpc = connect(w, forward);
    await rpc.call("hello", '{"protocol":3}');
    out.refusals = [];
    for (const [params] of REFUSALS) (out.refusals as unknown[]).push(await rpc.call("host.repo.setup", params));
    out.refusedState = state(w);
    out.admitted = await admitted(w, async params => mask(await rpc.call("host.repo.setup", params)));
    await rpc.close();

    const sessions: string[] = [rpc.stderr.text];
    for (const env of [{PACER_ENFORCEMENT_TOKEN: "t"}, {PACER_WORK_GRANT: GRANT}] as Record<string, string>[]) {
      const scoped = connect(w, forward, env);
      await scoped.call("hello", '{"protocol":3}');
      out[Object.keys(env)[0]!] = [await scoped.call("host.repo.setup", setup()), await scoped.call("host.repo.setup", `{"alias":"box","key":"${KEY}"}`)];
      await scoped.close();
      sessions.push(scoped.stderr.text);
    }
    out.state = state(w);
    return {out, sessions, calls: setupCalls(w)};
  }

  test("reply lines and effects match the forwarded path; refusals never reach Core", async () => {
    const w = world();
    const native = await scenarios(w);
    const forwarded = await scenarios(w, FORWARD);
    expect(native.out).toEqual(forwarded.out);

    const [operator, enforced, granted] = native.sessions;
    expect(operator).toMatch(TRACED);
    expect(enforced).toMatch(TRACED);
    expect(granted).not.toMatch(TRACED);
    for (const trace of forwarded.sessions) expect(trace).not.toMatch(TRACED);
    // Admitted requests are forwarded unchanged; then the work-grant session forwards both of its requests.
    expect(native.calls).toEqual(Array(ADMITTED + 2).fill("host.repo.setup"));
    expect(forwarded.calls).toEqual(Array(REFUSALS.length + ADMITTED + 4).fill("host.repo.setup"));

    const r = native.out as Record<string, any>;
    expect((r.refusals as string[]).map(line => JSON.parse(line).error)).toEqual(REFUSALS.map(([, error]) => {
      const {code, message, hint} = error as {code: string; message: string; hint?: string};
      return {code: -32602, message, data: {code, ...(hint ? {hint} : {})}};
    }));
    expect(JSON.parse(r.refusedState).jobs).toEqual([]);
    expect(JSON.parse(r.admitted.notFound.reply).error).toMatchObject({message: "local repo checkout not found", data: {code: "invalid_input"}});
    expectAdmitted(r.admitted, reply => JSON.parse(reply as string).result.job);
    for (const line of r.PACER_ENFORCEMENT_TOKEN as string[]) {
      expect(JSON.parse(line).error).toMatchObject({message: "Enforcement identity only reports a native child denial", data: {code: "not_allowed"}});
    }
    for (const line of r.PACER_WORK_GRANT as string[]) expect(JSON.parse(line).error).toBeDefined();
  }, LONG);
});
