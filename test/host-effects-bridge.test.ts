import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { hostEffectsBridge } from "../src/api/host-effects-bridge";
import { rpcError } from "../src/api/errors";
import { callOp } from "../src/api/ops";
import { runStdio } from "../src/api/stdio";
import { getJob, type Job } from "../src/jobs/registry";
import type { HostWorktree } from "../src/remote/hosts";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

const KEY = "fixture-private-key";
const TOKEN = "i".repeat(64);
const ORIGIN = "https://github.com/o/r.git";
/** Parity tests run the same SSH job twice through real plugin processes and git. */
const SSH_JOBS = 120_000;

function session(home: string, at: number, used: number) {
  const dir = join(home, "sessions", "2026", "10");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, `${JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), payload: { rate_limits: {
    primary: { used_percent: used, window_minutes: 300, resets_in_seconds: 3600 },
    secondary: { used_percent: 20, window_minutes: 10080, resets_at: at + 7200 },
  } } })}\n`);
  utimesSync(path, at, at);
}

/**
 * A configured host `box` whose SSH runs locally against a fake host home through the real pacer-ssh and
 * pacer-remote-caller plugins. Every path lives under one root, so two fixtures differ only by that root.
 */
async function fixture() {
  const root = tmpDir();
  const repo = join(root, "repo"), checkout = join(root, "checkout"), hostHome = join(root, "host-home"),
    bin = join(root, "bin"), log = join(root, "ssh.log"), down = join(root, "down"), ssh = join(bin, "ssh");
  for (const dir of [repo, checkout, hostHome, bin, join(root, "home")]) mkdirSync(dir, { recursive: true });
  const probe = `__PACER_BEGIN__\ngit=git version 2.40.0\nsetsid=/bin/setsid\nscript=script from util-linux 2.40\ntail=tail (GNU coreutils) 9.5\ntail_pid=1\ncodex=/bin/codex\nclaude=\nhome=${hostHome}\n`;
  writeFileSync(join(root, "probe"), probe);
  writeFileSync(ssh, `#!/bin/sh\nPACER_FAKE_HOST_HOME=${JSON.stringify(hostHome)} PACER_FAKE_SSH_LOG=${JSON.stringify(log)} PACER_FAKE_SSH_DOWN=; export PACER_FAKE_HOST_HOME PACER_FAKE_SSH_LOG PACER_FAKE_SSH_DOWN\n[ ! -e ${JSON.stringify(down)} ] || { echo 'ssh: connection refused' >&2; exit 255; }\ncase "$*" in *"command -v codex"*) cat ${JSON.stringify(join(root, "probe"))}; exit 0;; *" clone ${ORIGIN}") GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${JSON.stringify(`url.${repo}.insteadOf`)} GIT_CONFIG_VALUE_0=${ORIGIN}; export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0;; esac\nexec ${JSON.stringify(join(import.meta.dir, "fixtures", "bin", "ssh"))} "$@"\n`);
  chmodSync(ssh, 0o755);
  const ctx = fakeCtx({ home: join(root, "home"), env: { ...fakeSshEnv(hostHome, log), PATH: `${bin}:${process.env.PATH}` } });
  ctx.which = name => name === "ssh" ? ssh : null;
  ctx.run = (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...ctx.env, ...o?.env } });
  const git = async (dir: string, ...args: string[]) => {
    const r = await ctx.run(["git", "-C", dir, ...args], 10000);
    if (r.code) throw Error(r.stderr);
    return r.stdout.trim();
  };
  for (const dir of [repo, checkout]) {
    await git(dir, "init", "-q", "-b", "main");
    await git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    await git(dir, "remote", "add", "origin", ORIGIN);
    await git(dir, "config", "--local", "user.name", "Test User");
    await git(dir, "config", "--local", "user.email", "test@example.invalid");
  }
  mkdirSync(join(hostHome, ".codex-team"));
  session(join(hostHome, ".codex"), ctx.now - 20, 45);
  session(join(hostHome, ".codex-team"), ctx.now - 30, 60);
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
    planner: "claude-code", hosts: { box: { ssh: "box-ssh", repos: { "github.com/o/r": checkout }, accounts: { team: { home: "~/.codex-team" } } } },
    routing: [{ default: ["codex@box", "codex#team@box", "codex"] }],
  }));
  const tasks: string[] = [];
  /** A settled, dismissed task that ran on `box` with a remote worktree and run dir in the fake host home. */
  const remoteTask = async (taskRepo = repo) => {
    const t = createTask(ctx, { brief: { goal: "cleanup", repo: taskRepo }, kind: null, requestedExecutor: null, timeoutS: 60 });
    tasks.push(t.id);
    const worktree = join(hostHome, ".pacer-remote", "worktrees", "repo-test", `${t.id}-1`), dir = join(hostHome, ".pacer-remote", "runs", t.id, "1");
    mkdirSync(join(hostHome, ".pacer-remote", "worktrees", "repo-test"), { recursive: true });
    await git(checkout, "worktree", "add", "-q", "-b", `pacer/${t.id}`, worktree);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.raw"), "recorded output");
    updateTask(ctx, t.id, record => {
      record.state = "done"; record.dismissed = true;
      record.run = { host: "box", mode: "new", remoteWorktree: worktree, remoteDir: dir, workdir: worktree, dir: "unused", attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" };
    });
    return { id: t.id, worktree, dir };
  };
  const sshCalls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
  return { root, ctx, repo, checkout, hostHome, git, down, remoteTask, tasks, sshCalls };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Root paths and task ids differ between two fixtures; every other byte of a value must match. */
function normalize(f: Fixture, value: unknown): unknown {
  let text = JSON.stringify(value).replaceAll(f.root, "<root>");
  f.tasks.forEach((id, i) => { text = text.replaceAll(id, `<task-${i}>`); });
  return JSON.parse(text);
}

/** Jobs, host checks and the remote usage cache, as written. A job's id is random and its endedAt is wall time. */
function stateFiles(f: Fixture) {
  const read = (path: string) => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const dir = (path: string) => existsSync(path) ? readdirSync(path).filter(name => name.endsWith(".json")).sort() : [];
  const jobsDir = join(f.ctx.pacerHome, "state", "jobs"), usageDir = join(f.ctx.pacerHome, "cache", "remote-usage");
  const jobs = dir(jobsDir).map(name => {
    const job = read(join(jobsDir, name)) as Job;
    expect(name).toBe(`${job.id}.json`);
    if (job.endedAt !== undefined) expect(job.endedAt).toBeGreaterThanOrEqual(job.startedAt);
    return { ...job, id: "<job>", ...(job.endedAt !== undefined ? { endedAt: "<ended>" } : {}) };
  });
  return normalize(f, {
    jobs,
    hostChecks: read(join(f.ctx.pacerHome, "state", "host-checks.json")),
    usage: Object.fromEntries(dir(usageDir).map(name => [name, read(join(usageDir, name))])),
  });
}

/** A reply or error in its JSON-RPC wire shape, with the job id and wall-clock endedAt normalized. */
function reply(f: Fixture, out: { result?: unknown; error?: unknown }) {
  if (out.error !== undefined) return normalize(f, { error: out.error });
  const value = out.result as { job?: Job };
  const job = value?.job && { ...value.job, id: "<job>", ...(value.job.endedAt !== undefined ? { endedAt: "<ended>" } : {}) };
  return normalize(f, { result: job ? { ...value, job } : value });
}

async function direct(ctx: Ctx, kind: string, params: unknown) {
  try { return { result: await callOp(ctx, kind, params) }; } catch (e) { return { error: rpcError(e) }; }
}

/** `key` is the core's own key; `null` starts a core that has none. */
async function stdio(ctx: Ctx, params: unknown, key: string | null = KEY) {
  async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.host.effects", params }); }
  const out: { id: unknown; result?: unknown; error?: { code: number; data: { code: string } } }[] = [];
  await runStdio(ctx, input(), line => out.push(JSON.parse(line)), { nativeConfigKey: key ?? undefined });
  expect(out).toHaveLength(1);
  return out[0];
}

async function withServer<T>(ctx: Ctx, run: (post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; text: string }>) => Promise<T>) {
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
  try {
    return await run(async (path, body, headers = { authorization: `Bearer ${TOKEN}` }) => {
      const r = await fetch(`http://127.0.0.1:${s.port}${path}`, {
        method: "POST", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      return { status: r.status, text: await r.text() };
    });
  } finally { s.stop(); }
}

async function settled(ctx: Ctx, id: string): Promise<Job> {
  const until = Date.now() + 30_000;
  while (getJob(ctx, id).state === "running" && Date.now() < until) await Bun.sleep(20);
  return getJob(ctx, id);
}

test("only the three host operations dispatch, with no other request fields, before any effect", async () => {
  const f = await fixture();
  const refused = [undefined, null, [], "host.check", {}, { kind: 1 }, { kind: "host.terminal", params: { alias: "box" } },
    { kind: "host.list" }, { kind: "service.install", params: { consent: true } }, { kind: "__proto__" }, { kind: "constructor" },
    { kind: "host.check", params: { alias: "box" }, argv: ["sh", "-c", "id"] }, { kind: "host.check", params: { alias: "box" }, key: KEY }];
  for (const request of refused) {
    await expect(hostEffectsBridge(f.ctx, request)).rejects.toMatchObject({ code: "invalid_input", message: "host effect required" });
    expect(await stdio(f.ctx, { key: KEY, request })).toMatchObject({ id: 1, error: { code: -32602, message: "host effect required", data: { code: "invalid_input" } } });
  }
  await withServer(f.ctx, async post => {
    for (const request of refused) {
      const r = await post("/_internal/host-effects", { request });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text)).toEqual({ error: { code: "invalid_input", message: "host effect required" } });
    }
    const unparsable = await post("/_internal/host-effects", "not json");
    expect(unparsable.status).toBe(400);
  });
  expect(f.sshCalls()).toBe(0);
  expect(stateFiles(f)).toEqual({ jobs: [], hostChecks: null, usage: {} });
});

test("the sealed stdio method answers unknown_op for a missing or wrong key and for a work-grant caller", async () => {
  const f = await fixture();
  const request = { kind: "host.check", params: { alias: "box" } };
  const granted: Ctx = { ...f.ctx, env: { ...f.ctx.env, PACER_WORK_GRANT: "pwg_fixture" } };
  const refused = [
    await stdio(f.ctx, { key: "incorrect", request }),
    await stdio(f.ctx, { request }),
    await stdio(f.ctx, null),
    await stdio(f.ctx, { key: KEY, request }, null),
    await stdio(f.ctx, { key: "", request }, ""),
    await stdio(granted, { key: KEY, request }),
  ];
  for (const out of refused) {
    expect(out).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "unknown operation", data: { code: "unknown_op" } } } as never);
    expect(JSON.stringify(out)).not.toContain(KEY);
  }
  expect(f.sshCalls()).toBe(0);
  expect(stateFiles(f)).toEqual({ jobs: [], hostChecks: null, usage: {} });
});

test("the HTTP route accepts only the internal bearer and refuses cookie and task callers", async () => {
  const f = await fixture();
  const body = { request: { kind: "host.check", params: { alias: "box", repo: f.repo } } };
  await withServer(f.ctx, async post => {
    expect((await post("/_internal/host-effects", body, {})).status).toBe(401);
    expect((await post("/_internal/host-effects", body, { authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
    expect((await post("/_internal/host-effects", body, { authorization: TOKEN })).status).toBe(401);
    const internal = { authorization: `Bearer ${TOKEN}` };
    expect(await post("/_internal/host-effects", body, { ...internal, "x-pacer-auth": "cookie" })).toEqual({ status: 403, text: "forbidden\n" });
    expect(await post("/_internal/host-effects", body, { ...internal, "x-pacer-auth": "task", "x-pacer-work-grant": "Bearer pwg_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
    expect(await post("/_internal/host-effects", body, { ...internal, "x-pacer-auth": "task", "x-pacer-work-grant": "Bearer pet_fixture" })).toEqual({ status: 403, text: "forbidden\n" });
    expect(await post("/_internal/host-effects", body, { ...internal, "x-pacer-auth": "other" })).toEqual({ status: 403, text: "forbidden\n" });
    expect(f.sshCalls()).toBe(0);
    expect(stateFiles(f)).toEqual({ jobs: [], hostChecks: null, usage: {} });

    const admitted = await post("/_internal/host-effects", body, { ...internal, "x-pacer-auth": "bearer" });
    expect(admitted.status).toBe(200);
    const { job } = (JSON.parse(admitted.text) as { result: { job: Job } }).result;
    expect(job).toMatchObject({ kind: "host.check", target: "box", state: "running" });
    expect((await settled(f.ctx, job.id)).state).toBe("passed");
  });
}, SSH_JOBS);

test("refusals equal the reference operation's errors and write nothing", async () => {
  const requests: [string, unknown][] = [
    ["host.check", { alias: "nope" }],
    ["host.check", {}],
    ["host.check", { alias: "box", repo: "" }],
    ["host.check", { alias: "x".repeat(129) }],
    ["host.clean", { alias: "nope" }],
    ["host.clean", { alias: "nope", dry_run: true }],
    ["host.clean", { alias: "box", dry_run: "yes" }],
    ["host.repo.setup", { alias: "box", key: "github.com/o/r" }],
    ["host.repo.setup", { alias: "box", key: "github.com/o/r", consent: false }],
    ["host.repo.setup", { alias: "nope", key: "github.com/o/r", consent: true }],
    ["host.repo.setup", { alias: "box", key: "github.com/o/unmapped", consent: true }],
    ["host.repo.setup", { alias: "box", key: "not-canonical", consent: true }],
  ];
  const a = await fixture(), b = await fixture();
  await withServer(b.ctx, async post => {
    for (const [kind, params] of requests) {
      const expected = reply(a, await direct(a.ctx, kind, params));
      expect(expected).toMatchObject({ error: { data: { code: "invalid_input" } } });
      expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind, params } }))).toEqual(expected);
      await expect(hostEffectsBridge(b.ctx, { kind, params })).rejects.toMatchObject({ code: "invalid_input", message: (expected as { error: { message: string } }).error.message });
      const bridged = await post("/_internal/host-effects", { request: { kind, params } });
      const reference = await post(`/v3/ops/${kind}`, params);
      expect(bridged).toEqual(reference);
      expect(bridged.status).toBe(400);
    }
  });
  for (const f of [a, b]) {
    expect(f.sshCalls()).toBe(0);
    expect(stateFiles(f)).toEqual({ jobs: [], hostChecks: null, usage: {} });
  }
});

test("host.check over the sealed stdio method writes the same job, host check and usage cache as a direct call", async () => {
  const a = await fixture(), b = await fixture();
  const expected = reply(a, await direct(a.ctx, "host.check", { alias: "box", repo: a.repo }));
  expect(expected).toMatchObject({ result: { job: { kind: "host.check", target: "box", state: "passed" } } });
  expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.check", params: { alias: "box", repo: b.repo } } }))).toEqual(expected);
  const files = stateFiles(a);
  expect(files).toMatchObject({ jobs: [{ kind: "host.check", state: "passed" }], hostChecks: { box: { ok: true, at: a.ctx.now } } });
  expect(Object.keys((files as { usage: object }).usage)).toEqual(["codex.json", "team.json"]);
  expect(stateFiles(b)).toEqual(files);
  expect(b.sshCalls()).toBe(a.sshCalls());
}, SSH_JOBS);

test("host.check over HTTP settles to the same files as a direct call, including an unreachable host", async () => {
  for (const reachable of [true, false]) {
    const a = await fixture(), b = await fixture();
    if (!reachable) for (const f of [a, b]) writeFileSync(f.down, "");
    const params = { alias: "box", repo: a.repo };
    const expected = reply(a, await direct(a.ctx, "host.check", params));
    expect(expected).toMatchObject({ result: { job: { state: reachable ? "passed" : "failed" } } });
    await withServer(b.ctx, async post => {
      const r = await post("/_internal/host-effects", { request: { kind: "host.check", params: { ...params, repo: b.repo } } });
      expect(r.status).toBe(200);
      const { job } = (JSON.parse(r.text) as { result: { job: Job } }).result;
      expect(job).toMatchObject({ kind: "host.check", target: "box", state: "running", startedAt: b.ctx.now });
      expect(reply(b, { result: { job: await settled(b.ctx, job.id) } })).toEqual(expected);
    });
    expect(stateFiles(b)).toEqual(stateFiles(a));
    if (!reachable) expect(stateFiles(a)).toMatchObject({ hostChecks: { box: { ok: false } }, usage: {} });
  }
}, SSH_JOBS);

test("host.repo.setup clones and sets identity exactly as a direct call", async () => {
  const a = await fixture(), b = await fixture();
  for (const f of [a, b]) {
    rmSync(f.checkout, { recursive: true });
    createTask(f.ctx, { brief: { goal: "setup", repo: f.repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  }
  const params = { alias: "box", key: "github.com/o/r", consent: true as const };
  const expected = reply(a, await direct(a.ctx, "host.repo.setup", params));
  expect(expected).toMatchObject({ result: { job: { kind: "host.repo.setup", target: "box:github.com/o/r", state: "passed",
    steps: [{ name: "Clone", state: "passed" }, { name: "Set identity", state: "passed" }, { name: "Check", state: "passed" }] } } });
  expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.repo.setup", params } }))).toEqual(expected);
  expect(stateFiles(b)).toEqual(stateFiles(a));
  for (const f of [a, b]) {
    expect(await f.git(f.checkout, "remote", "get-url", "origin")).toBe(ORIGIN);
    expect(await f.git(f.checkout, "config", "--local", "user.name")).toBe("Test User");
    expect(await f.git(f.checkout, "config", "--local", "user.email")).toBe("test@example.invalid");
  }
  expect(b.sshCalls()).toBe(a.sshCalls());
}, SSH_JOBS);

test("host.repo.setup refuses a missing local checkout and records a failed identity step identically", async () => {
  const a = await fixture(), b = await fixture();
  const params = { alias: "box", key: "github.com/o/r", consent: true as const, clone: false };
  const notFound = reply(a, await direct(a.ctx, "host.repo.setup", params));
  expect(notFound).toEqual({ error: { code: -32602, message: "local repo checkout not found",
    data: { code: "invalid_input", hint: "Run pacer host setup from the local checkout, or delegate a task for that repo first." } } });
  expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.repo.setup", params } }))).toEqual(notFound);
  for (const f of [a, b]) {
    createTask(f.ctx, { brief: { goal: "setup", repo: f.repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
    await f.git(f.repo, "config", "--local", "--unset", "user.email");
  }
  const failed = reply(a, await direct(a.ctx, "host.repo.setup", params));
  expect(failed).toMatchObject({ result: { job: { state: "failed", error: { code: "invalid_input", message: "local repo needs user.name and user.email" } } } });
  expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.repo.setup", params } }))).toEqual(failed);
  expect(stateFiles(b)).toEqual(stateFiles(a));
}, SSH_JOBS);

test("host.clean removes and keeps the same worktrees as a direct call, and dry runs reply alike", async () => {
  const a = await fixture(), b = await fixture();
  const other = async (f: Fixture) => {
    const unmapped = join(f.root, "unmapped");
    mkdirSync(unmapped);
    await f.git(unmapped, "init", "-q", "-b", "main");
    await f.git(unmapped, "remote", "add", "origin", "https://github.com/o/other.git");
    return unmapped;
  };
  const runs = [];
  for (const f of [a, b]) runs.push([await f.remoteTask(), await f.remoteTask(await other(f))]);
  // Tasks list newest id first and ids are random, so the two fixtures may list them in either order.
  const worktrees = (out: unknown) => (out as { result: { worktrees: HostWorktree[] } }).result.worktrees.toSorted((x, y) => x.branch.localeCompare(y.branch));
  const preview = reply(a, await direct(a.ctx, "host.clean", { alias: "box", dry_run: true }));
  expect(Object.keys(preview as object)).toEqual(["result"]);
  expect(Object.keys((preview as { result: object }).result)).toEqual(["worktrees"]);
  expect(worktrees(preview)).toEqual([
    { branch: "pacer/<task-0>", state: "done", fate: "kept" }, { branch: "pacer/<task-1>", state: "done", fate: "kept" },
  ]);
  const bridgedPreview = reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.clean", params: { alias: "box", dry_run: true } } }));
  expect(Object.keys(bridgedPreview as object)).toEqual(["result"]);
  expect(Object.keys((bridgedPreview as { result: object }).result)).toEqual(["worktrees"]);
  expect(worktrees(bridgedPreview)).toEqual(worktrees(preview));
  expect(stateFiles(b)).toEqual({ jobs: [], hostChecks: null, usage: {} });

  const expected = reply(a, await direct(a.ctx, "host.clean", { alias: "box" }));
  expect(expected).toMatchObject({ result: { job: { kind: "host.clean", target: "box", state: "failed",
    steps: [{ name: "Clean", state: "failed", detail: "<task-1>: remote cleanup needs a configured host, checkout and run" }] } } });
  expect(reply(b, await stdio(b.ctx, { key: KEY, request: { kind: "host.clean", params: { alias: "box" } } }))).toEqual(expected);
  expect(stateFiles(b)).toEqual(stateFiles(a));
  for (const [removed, kept] of runs) {
    expect(existsSync(removed.worktree)).toBe(false);
    expect(existsSync(removed.dir)).toBe(false);
    expect(existsSync(kept.worktree)).toBe(true);
    expect(existsSync(kept.dir)).toBe(true);
  }
  expect(b.sshCalls()).toBe(a.sshCalls());
}, SSH_JOBS);
