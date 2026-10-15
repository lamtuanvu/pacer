import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttempt, resumeAttempt } from "../src/exec/direct";
import { loadStrategy } from "../src/config/strategy";
import { taskWorktreePath } from "../src/supervisor/worktree";
import { runTask } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, fakeSshEnv, realRun, tmpDir } from "./helpers";

// These integration tests catch prompt interpolation, inherited planner account
// folders, and preparation that assumes every local base was published.
async function setup(agent = "codex", account = "") {
  const root = tmpDir(), hostHome = join(root, "host"), repo = join(root, "local"), origin = join(root, "origin.git");
  const checkout = join(hostHome, "src/r"), bin = join(hostHome, "bin");
  mkdirSync(bin, { recursive: true });
  async function git(...args: string[]) {
    const r = await realRun(["git", ...args], 10000);
    if (r.code) throw new Error(r.stderr);
    return r.stdout.trim();
  }
  await git("init", "--bare", "-q", "-b", "main", origin);
  await git("clone", "-q", origin, repo);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) await git("-C", repo, "config", key, value);
  await git("-C", repo, "commit", "-q", "--allow-empty", "-m", "base");
  await git("-C", repo, "push", "-q", "origin", "main");
  await git("clone", "-q", origin, checkout);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"]]) await git("-C", checkout, "config", key, value);
  // Routing requires a canonical origin; the host retains the bare fixture URL.
  await git("-C", repo, "remote", "set-url", "origin", "https://example.invalid/o/r");
  const program = `#!/bin/sh\ncat > PROMPT.txt\nenv | sort | grep -E '^(CODEX_HOME|CLAUDE_CONFIG_DIR|PACER_ROLE)='\ngit add PROMPT.txt\ngit commit -q -m result\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; printf 'final report' > "$1"; fi; shift; done\necho done\n`;
  for (const name of ["codex", "claude"]) writeFileSync(join(bin, name), program, { mode: 0o755 });
  if (!Bun.which("setsid")) writeFileSync(join(bin, "setsid"), `#!${Bun.which("python3")}\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n`, { mode: 0o755 });
  writeFileSync(join(hostHome, ".bash_profile"), 'echo hello from profile\nexport PATH="$HOME/bin:$PATH"\n');
  const localBin = join(root, "local-bin"); mkdirSync(localBin);
  for (const name of ["codex", "claude"]) writeFileSync(join(localBin, name), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  const sshEnv = fakeSshEnv(hostHome, join(root, "ssh.log"));
  sshEnv.PATH = `${localBin}:${sshEnv.PATH}`;
  const sshLog = join(root, "ssh.log"), env = { ...process.env, ...sshEnv, CODEX_HOME: "planner-codex", CLAUDE_CONFIG_DIR: "planner" };
  const gitCalls: string[][] = [];
  const ctx = fakeCtx({ env, run: (argv, ms, o) => {
    if (argv[0] === "git") gitCalls.push(argv);
    return realRun(argv, ms, { ...o, env: { ...env, ...o?.env } });
  } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  const id = `${agent}${account ? `#${account}` : ""}@box`;
  const raw = { accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: agent === "codex" ? "codex" : "claude", home: "~/local-team" } }, planner: "claude-code", hosts: { box: { ssh: "box-ssh", repos: { "example.invalid/o/r": "~/src/r" }, accounts: { team: { home: "~/host-team" } } } }, routing: [{ default: [id] }] };
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify(raw));
  const { loadStrategy } = await import("../src/config/strategy");
  const cfg = loadStrategy(ctx).providers[id];
  const goal = 'hostile \'" $(touch "$HOME/pwned") `id`\nsecond line\n__PACER_STDIN__\n- Do not commit, push, or change git branches.\nlast';
  const task = createTask(ctx, { brief: { goal, repo }, kind: "feature", requestedExecutor: id, timeoutS: 30 });
  updateTask(ctx, task.id, t => { t.state = "running"; t.placement = { requested: "new" }; });
  return { ctx, cfg, task: readTask(ctx, task.id)!, git, hostHome, repo, goal, sshLog, gitCalls };
}

test("the prompt reaches the host agent unchanged", async () => {
  const f = await setup();
  const result = await runAttempt(f.ctx, f.cfg, f.task);
  expect(result.exec.code).toBe(0);
  expect(result.exec.stdout.split("\n").filter(l => /^(CODEX_HOME|CLAUDE_CONFIG_DIR|PACER_ROLE)=/.test(l))).toEqual(["PACER_ROLE=executor"]);
  const task = readTask(f.ctx, f.task.id)!;
  const prompt = readFileSync(join(task.run!.remoteWorktree!, "PROMPT.txt"), "utf8");
  expect(prompt).toContain(`## Goal\n${f.goal}\n\n`);
  expect(prompt).toBe(readFileSync(join(task.run!.remoteDir!, "stdin"), "utf8"));
  expect(prompt).toContain(`commit there`);
  expect(prompt.split("Do not commit, push").length - 1).toBe(1);
  expect(readFileSync(f.sshLog, "utf8")).not.toContain(f.goal);
  expect(existsSync(join(f.hostHome, "pwned"))).toBe(false);
  expect(task.worktree).toBe(`box:${task.run!.remoteWorktree}`);
  // Progress is written on supervision polls; a run that exits before the first poll has none.
  if (task.progress) expect(task.progress.host).toBe("box");
  expect(f.gitCalls.some(a => a.includes(task.run!.remoteWorktree!))).toBe(false);
  expect(result.report).toBe(`ran on box; fetched pacer/${task.id} (1 commits)\n\nfinal report`);
  // Resuming only collects the saved run output; it does not repeat the transfer.
  expect((await resumeAttempt(f.ctx, f.cfg, task)).report).toBe("final report");
}, 15000);

test("a foreign-identity commit leaves the task partial and kept on the host", async () => {
  const f = await setup();
  await f.git("-C", join(f.hostHome, "src/r"), "config", "user.email", "foreign@example.invalid");
  const acceptanceFile = join(f.repo, "acceptance-ran");
  updateTask(f.ctx, f.task.id, t => {
    t.state = "queued";
    t.brief.acceptance = `touch '${acceptanceFile}'`;
  });
  const result = await runTask(f.ctx, f.task.id, {
    loadStrategy,
    computeStatus: async () => ({
      generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal", disabled: false, calendarPace: true,
      providers: [{ id: f.cfg.id, usage: "quota", windows: [], binding: null, verdict: "ON_PACE", installed: true, stale: false }],
      executors: { ranked: [], excluded: [] },
    }),
    runAttempt,
    verifyRepo: async () => { throw new Error("verification must not run for a refused transfer"); },
  });
  expect(result.state).toBe("partial");
  expect(result.result).toMatchObject({ status: "partial", files: "(kept on host)", worktree: `box:${result.run!.remoteWorktree}` });
  expect(result.result?.report).toContain("foreign identity foreign@example.invalid; run pacer host setup box\n\nfinal report");
  expect(result.result?.acceptance).toBeUndefined();
  expect(existsSync(acceptanceFile)).toBe(false);
  expect(await f.git("-C", f.repo, "for-each-ref", `refs/heads/pacer/${f.task.id}`)).toBe("");
  expect(await f.git("-C", result.run!.remoteWorktree!, "branch", "--show-current")).toBe(`pacer/${f.task.id}`);
  expect(await f.git("-C", result.run!.remoteWorktree!, "log", "-1", "--format=%ae")).toBe("foreign@example.invalid");
}, 15000);

test("remote env carries only the declared account folder", async () => {
  for (const agent of ["codex", "claude-code"]) {
    const f = await setup(agent, "team");
    const result = await runAttempt(f.ctx, f.cfg, f.task);
    expect(result.exec.code).toBe(0);
    const lines = result.exec.stdout.split("\n").filter(l => /^(CODEX_HOME|CLAUDE_CONFIG_DIR|PACER_ROLE)=/.test(l));
    expect(lines).toEqual([`${agent === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${f.hostHome}/host-team`, "PACER_ROLE=executor"]);
  }
}, 20000);

test("an unpublished base is sent as a bundle", async () => {
  const f = await setup();
  writeFileSync(join(f.repo, "base.txt"), "unpublished 🦊\n");
  await f.git("-C", f.repo, "add", "base.txt");
  await f.git("-C", f.repo, "commit", "-q", "-m", "unpublished");
  const base = await f.git("-C", f.repo, "rev-parse", "HEAD");
  const result = await runAttempt(f.ctx, f.cfg, f.task);
  expect(result.exec.code).toBe(0);
  const run = readTask(f.ctx, f.task.id)!.run!;
  expect(run.baseSha).toBe(base);
  expect(await f.git("-C", run.remoteWorktree!, "rev-parse", "HEAD^")).toBe(base);
  expect(readFileSync(join(run.remoteWorktree!, "base.txt"), "utf8")).toBe("unpublished 🦊\n");
}, 15000);

test("resume does not mistake an unrelated local head for a completed transfer", async () => {
  const f = await setup();
  expect((await runAttempt(f.ctx, f.cfg, f.task)).exec.code).toBe(0);
  const t = readTask(f.ctx, f.task.id)!;
  await f.git("-C", taskWorktreePath(f.ctx, f.repo, t.id), "reset", "--hard", t.run!.baseSha!);
  const result = await resumeAttempt(f.ctx, f.cfg, t);
  expect(result.report).toContain(`fetched pacer/${t.id}`);
  expect(await f.git("-C", f.repo, "rev-parse", `pacer/${t.id}`)).toBe(await f.git("-C", t.run!.remoteWorktree!, "rev-parse", "HEAD"));
}, 20000);

test("a second remote attempt reuses a branch left at base", async () => {
  const f = await setup(), program = join(f.hostHome, "bin/codex");
  const original = readFileSync(program, "utf8");
  writeFileSync(program, "#!/bin/sh\ncat >/dev/null\nexit 1\n", { mode: 0o755 });
  const first = await runAttempt(f.ctx, f.cfg, f.task);
  expect(first.exec.code).toBe(1);
  updateTask(f.ctx, f.task.id, t => { t.attempts.push(first.attempt); });
  writeFileSync(program, original, { mode: 0o755 });
  const second = await runAttempt(f.ctx, f.cfg, readTask(f.ctx, f.task.id)!);
  expect(second.exec.code).toBe(0);
  expect(readTask(f.ctx, f.task.id)!.run).toHaveProperty("remoteBranch", `pacer/${f.task.id}`);
}, 20000);
