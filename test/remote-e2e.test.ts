import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as tasks from "../src/core/tasks";
import { clean as hostClean } from "../src/remote/hosts";
import { loadStrategy } from "../src/config/strategy";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { readTask, updateTask } from "../src/tasks/store";
import { taskStatus, taskStop } from "../src/tasks/api";
import { RemoteRunIO } from "../src/remote/run-io";
import { remoteLaunch } from "../src/exec/launch";
import { runAttempt, runDir } from "../src/exec/direct";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

async function setup(wait = false) {
  const root = tmpDir(), hostHome = join(root, "host"), repo = join(root, "local"), origin = join(root, "origin.git");
  const checkout = join(hostHome, "src/r"), bin = join(hostHome, "bin");
  mkdirSync(bin, { recursive: true });
  const git = async (...args: string[]) => {
    const r = await realRun(["git", ...args], 10000);
    if (r.code) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  await git("init", "--bare", "-q", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  await git("-C", repo, "config", "user.name", "Test");
  await git("-C", repo, "config", "user.email", "test@example.invalid");
  await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  await git("-C", repo, "push", "-q", "origin", "main");
  await git("clone", "-q", origin, checkout);
  await git("-C", checkout, "config", "user.name", "Test");
  await git("-C", checkout, "config", "user.email", "test@example.invalid");
  await git("-C", repo, "remote", "set-url", "origin", "https://example.invalid/o/r");
  writeFileSync(join(bin, "codex"), `#!/bin/sh\ncat > PROMPT.txt\necho agent-started\n${wait ? 'while [ ! -f "$HOME/release" ]; do sleep 0.05; done' : ''}\ngit add PROMPT.txt\ngit commit -q -m result\necho agent-done\n`, { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
  writeFileSync(join(hostHome, ".bash_profile"), 'echo hello from profile\nexport PATH="$HOME/bin:$PATH"\n');
  const env = { ...process.env, ...fakeSshEnv(hostHome, join(root, "ssh.log")), PACER_BACKEND: "direct" };
  const ctx = fakeCtx({ env, run: (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...env, ...o?.env } }) });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code", hosts: { box: { ssh: "box-ssh", repos: { "example.invalid/o/r": "~/src/r" } } }, routing: [{ default: ["codex@box"] }] }));
  const deps: RunnerDeps = {
    loadStrategy,
    computeStatus: async () => ({ generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, paused: null, modeHold: null, calendarPace: true,
      providers: [{ id: "codex@box", usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false }], executors: { ranked: [], excluded: [] } }),
    verifyRepo: async (worktree) => {
      expect(existsSync(join(worktree, "PROMPT.txt"))).toBe(true);
      return { files: "PROMPT.txt" };
    },
  };
  const task = tasks.delegate(ctx, { brief: { goal: "Create and commit PROMPT.txt", repo }, executor: "codex@box", worktree: "new" }, () => undefined);
  return { ctx, task, deps, git, hostHome, checkout, repo, sshLog: join(root, "ssh.log") };
}

async function until(check: () => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("condition timed out"); await Bun.sleep(20); }
}

test("a remote task runs end to end", async () => {
  const f = await setup();
  const t = await runTask(f.ctx, f.task.id, f.deps);
  expect(t.state).toBe("done");
  expect(t.result?.report).toStartWith(`ran on box; fetched pacer/${t.id}`);
  expect(await f.git("-C", f.repo, "log", "-1", "--format=%s", `pacer/${t.id}`)).toBe("result");
  expect(tasks.log(f.ctx, t.id).stdout).toContain("agent-done");
}, 20000);

test("a remote attempt resumes after the runner dies", async () => {
  const f = await setup(true), id = f.task.id;
  // Persist exactly the record a dead runner leaves, with a real detached host
  // process but no surviving in-process supervisor competing with the restart.
  const worktree = join(f.hostHome, "worktree"), remoteDir = join(f.hostHome, ".pacer-remote/runs", id, "1");
  const baseSha = await f.git("-C", f.repo, "rev-parse", "HEAD");
  await f.git("-C", f.checkout, "worktree", "add", "-q", "-b", `pacer/${id}`, worktree, baseSha);
  const dir = runDir(f.ctx, id, 1), host = loadStrategy(f.ctx).hosts.box;
  const launch = remoteLaunch(loadStrategy(f.ctx).providers["codex@box"], worktree, remoteDir);
  const io = new RemoteRunIO(f.ctx, host, remoteDir, dir);
  expect(await io.start(launch.argv, worktree, { PACER_ROLE: "executor" }, "resume prompt")).toHaveProperty("pid");
  const run = { dir, attempt: 1, executor: "codex@box", startedAt: Date.now()/1000, mode: "new" as const, workdir: worktree, logFile: join(dir, "legacy.log"), host: "box", remoteDir, remoteWorktree: worktree, baseSha };
  updateTask(f.ctx, id, t => { t.state = "running"; t.runnerPid = 2147483647; t.attemptStartedAt = run.startedAt; t.run = run; t.baseBranch = "main"; t.placement = { requested: "new", mode: "new", why: "agent" }; });
  // A remote pid must never be checked against the local process table.
  writeFileSync(join(dir, "pid"), "2147483647");
  let resumed: ReturnType<typeof runTask> | undefined;
  try {
    taskStatus(f.ctx, id, () => { resumed = runTask(f.ctx, id, f.deps); return process.pid; });
    expect(resumed).toBeDefined();
  } finally { writeFileSync(join(f.hostHome, "release"), ""); }
  const t = await resumed!;
  expect(t.state).toBe("done");
  expect(t.result?.report).toStartWith(`ran on box; fetched pacer/${id}`);
  expect(readdirSync(join(f.hostHome, ".pacer-remote/runs", id))).toEqual(["1"]);
  expect(t.run?.remoteDir).toBe(remoteDir);
  expect(readFileSync(join(t.result!.worktree!, "PROMPT.txt"), "utf8")).toBe("resume prompt");
}, 20000);

test("stopping a remote task kills it on the host", async () => {
  const f = await setup(true), running = runTask(f.ctx, f.task.id, f.deps);
  await until(() => !!readTask(f.ctx, f.task.id)?.childPid);
  const run = readTask(f.ctx, f.task.id)!.run!;
  // No runner remains to observe the stop flag; taskStop must contact the host.
  updateTask(f.ctx, f.task.id, t => { t.runnerPid = 2147483647; delete t.childPid; });
  try {
    expect(taskStop(f.ctx, f.task.id)?.state).toBe("stopped");
    await until(() => readFileSync(f.sshLog, "utf8").includes('D="$1"; grace="$2"'), 1000);
    await until(() => existsSync(join(run.remoteDir!, "exit")));
    const io = new RemoteRunIO(f.ctx, loadStrategy(f.ctx).hosts.box, run.remoteDir!, run.dir);
    expect((await io.read()).alive).toBe(false);
    expect((await running).state).toBe("stopped");
  } finally { writeFileSync(join(f.hostHome, "release"), ""); await running; }
}, 20000);

test("clean removes the remote worktree and run dir after review", async () => {
  const f = await setup(), t = await runTask(f.ctx, f.task.id, f.deps);
  expect(t.state).toBe("done");
  tasks.review(f.ctx, t.id, { accepted: true });
  expect((await tasks.clean(f.ctx, { dryRun: true })).removed).toContain(t.id);
  expect(existsSync(t.run!.remoteWorktree!)).toBe(true);
  expect((await tasks.clean(f.ctx)).removed).toContain(t.id);
  expect(existsSync(t.run!.remoteWorktree!)).toBe(false);
  expect(existsSync(t.run!.remoteDir!)).toBe(false);
  expect(existsSync(t.result!.worktree!)).toBe(false);
  expect(await f.git("-C", f.checkout, "for-each-ref", `refs/heads/pacer/${t.id}`)).toBe("");
  expect(await f.git("-C", f.repo, "show-ref", "--verify", `refs/heads/pacer/${t.id}`)).not.toBe("");
}, 20000);

test("clean keeps the remote branch when transfer was refused", async () => {
  const f = await setup();
  await f.git("-C", f.checkout, "config", "user.email", "foreign@example.invalid");
  const t = await runTask(f.ctx, f.task.id, f.deps);
  expect(t.state).toBe("partial");
  tasks.review(f.ctx, t.id, { accepted: false });
  expect((await tasks.clean(f.ctx)).removed).toContain(t.id);
  expect(existsSync(t.run!.remoteWorktree!)).toBe(false);
  expect(existsSync(t.run!.remoteDir!)).toBe(false);
  expect(await f.git("-C", f.checkout, "log", "-1", "--format=%s", `pacer/${t.id}`)).toBe("result");
  expect(await f.git("-C", f.repo, "for-each-ref", `refs/heads/pacer/${t.id}`)).toBe("");
}, 20000);

for (const hostOnly of [false, true]) test(`clean ${hostOnly ? "host" : "core"} preserves a remote branch when the local head differs`, async () => {
  const f = await setup(), t = await runTask(f.ctx, f.task.id, f.deps);
  expect(t.state).toBe("done");
  const head = await f.git("-C", f.repo, "rev-parse", `pacer/${t.id}`);
  expect(t.run).toHaveProperty("transferredHead", head);
  await f.git("-C", f.repo, "update-ref", `refs/heads/pacer/${t.id}`, t.run!.baseSha!);
  tasks.review(f.ctx, t.id, { accepted: true });
  const result = hostOnly ? await hostClean(f.ctx, "box") : await tasks.clean(f.ctx, { force: true });
  expect(result.removed).toContain(t.id);
  expect(await f.git("-C", f.checkout, "rev-parse", `pacer/${t.id}`)).toBe(head);
}, 20000);

test("repeat remote attempts start and clean removes every attempt run directory", async () => {
  const f = await setup(), cfg = loadStrategy(f.ctx).providers["codex@box"];
  const first = await runAttempt(f.ctx, cfg, readTask(f.ctx, f.task.id)!);
  expect(first.exec.code).toBe(0);
  const previous = readTask(f.ctx, f.task.id)!.run!;
  updateTask(f.ctx, f.task.id, t => { t.attempts.push(first.attempt); });
  const second = await runAttempt(f.ctx, cfg, readTask(f.ctx, f.task.id)!);
  expect(second.exec.code).toBe(0);
  const run = readTask(f.ctx, f.task.id)!.run!;
  expect(run.remoteWorktree).toEndWith(`${f.task.id}-2`);
  expect(run).toHaveProperty("remoteBranch", `pacer/${f.task.id}-2`);
  expect(second.report).toContain(`fetched pacer/${f.task.id}-r2`);
  expect(existsSync(previous.remoteDir!)).toBe(true);
  expect(existsSync(run.remoteDir!)).toBe(true);
  updateTask(f.ctx, f.task.id, t => { t.state = "done"; t.review = { accepted: true, kind: null, note: null, at: f.ctx.now }; });
  expect((await hostClean(f.ctx, "box")).removed).toContain(f.task.id);
  expect(existsSync(join(f.hostHome, ".pacer-remote/runs", f.task.id))).toBe(false);
}, 30000);
