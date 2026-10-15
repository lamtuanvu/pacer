import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import * as hosts from "../src/remote/hosts";
import { main } from "../src/cli";
import { callOp } from "../src/api/ops";
import { fakeCtx, fakeSshEnv, gitRepo, realRun, tmpDir } from "./helpers";

async function fixture() {
  const repo = gitRepo(), checkout = gitRepo(), home = tmpDir();
  const ctx = fakeCtx({ env: fakeSshEnv(home, join(home, "ssh.log")) });
  ctx.run = (argv, ms, o) => realRun(argv, ms, { ...o, env: { ...ctx.env, ...o?.env } });
  const git = async (dir: string, ...args: string[]) => {
    const r = await ctx.run(["git", "-C", dir, ...args], 10000);
    if (r.code) throw Error(r.stderr);
    return r.stdout.trim();
  };
  for (const dir of [repo, checkout]) {
    await git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
    await git(dir, "config", "--local", "user.name", "Test User");
    await git(dir, "config", "--local", "user.email", "test@example.invalid");
  }
  mkdirSync(join(home, ".codex-team"));
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } },
    planner: "claude-code", hosts: { box: { ssh: "box-ssh", repos: { "github.com/o/r": checkout }, accounts: { team: { home: "~/.codex-team" } } } },
    routing: [{ default: ["codex@box", "codex#team@box", "codex"] }],
  }));
  // Real fake-SSH commands exercise checkout/account checks; make tool availability deterministic.
  const run = ctx.run;
  ctx.run = async (argv, ms, o) => {
    const r = await run(argv, ms, o);
    if (argv[0] === "ssh" && argv.at(-1)?.includes("command -v codex") && r.code === 0)
      return { ...r, stdout: `git=git version 2.40.0\nsetsid=/bin/setsid\ncodex=/bin/codex\nclaude=\nhome=${home}\n` };
    return r;
  };
  return { ctx, repo, checkout, home, git };
}

test("check passes on a prepared host and names each failure", async () => {
  const { ctx, repo, checkout, git } = await fixture();
  const check = () => hosts.check(ctx, "box", { repo });
  expect(await check()).toMatchObject({ alias: "box", ok: true });
  expect((await check()).checks.map(c => c.name)).toEqual(["ssh", "git", "setsid", "codex", "account homes", "checkout github.com/o/r", "identity github.com/o/r"]);
  await git(checkout, "config", "--local", "user.email", "wrong@example.invalid");
  expect((await check()).checks.find(c => c.name.startsWith("identity"))?.ok).toBe(false);
  await git(checkout, "remote", "set-url", "origin", "https://github.com/other/repo");
  expect((await check()).checks.find(c => c.name.startsWith("checkout"))?.ok).toBe(false);
  const run = ctx.run;
  ctx.run = async (argv, ms, o) => {
    const r = await run(argv, ms, o);
    return argv.at(-1)?.includes("command -v codex") ? { ...r, stdout: r.stdout.replace("codex=/bin/codex", "codex=").replace("git version 2.40.0", "git version 2.25.0") } : r;
  };
  expect((await check()).checks.find(c => c.name === "codex")?.ok).toBe(false);
  expect((await check()).checks.find(c => c.name === "git")?.detail).toContain("< 2.30");
  const { rmSync } = await import("node:fs");
  rmSync(join(ctx.env.PACER_FAKE_HOST_HOME!, ".codex-team"), { recursive: true });
  expect((await check()).checks.find(c => c.name === "account homes")?.ok).toBe(false);
  ctx.env.PACER_FAKE_SSH_DOWN = "box-ssh";
  const down = await check();
  expect(down.ok).toBe(false);
  expect(down.checks[0]).toMatchObject({ name: "ssh", ok: false });
  expect(down.checks.slice(1).every(c => c.detail === "skipped")).toBe(true);
});

test("setup sets the repo-local identity only after confirmation", async () => {
  const { ctx, repo, checkout, git } = await fixture();
  await git(checkout, "config", "--local", "user.name", "Other");
  expect((await hosts.setup(ctx, "box", repo, async () => false)).ok).toBe(false);
  expect(await git(checkout, "config", "--local", "user.name")).toBe("Other");
  const questions: string[] = [];
  expect((await hosts.setup(ctx, "box", repo, async q => { questions.push(q); return true; })).ok).toBe(true);
  expect(questions.join("\n")).toContain("identity");
  expect(await git(checkout, "config", "--local", "user.name")).toBe("Test User");
});

test("host CLI exit codes and read-only ops", async () => {
  const { ctx, repo } = await fixture();
  expect((await main(["host", "check", "box", "--repo", repo, "--json"], ctx)).code).toBe(0);
  expect((await main(["host", "list", "--json"], ctx)).code).toBe(0);
  expect((await hosts.list(ctx))[0]).toMatchObject({ alias: "box", running: 0, runners: ["codex@box", "codex#team@box"] });
  expect(await callOp(ctx, "host.list", {})).toEqual(await hosts.list(ctx));
  expect(await callOp(ctx, "host.check", { alias: "box", repo })).toMatchObject({ ok: true });
  ctx.env.PACER_FAKE_SSH_DOWN = "box-ssh";
  const failed = await main(["host", "check", "box", "--repo", repo], ctx);
  expect(failed.code).toBe(1);
  expect(failed.out).toContain("FAIL ssh");
  expect((await main(["host", "check"], ctx)).code).toBe(2);
  expect((await main(["host", "check", "unknown"], ctx)).code).toBe(2);
});

test("missing checkout setup previews clone and clones only with confirmation", async () => {
  const { ctx, repo, checkout, git } = await fixture();
  const { rmSync, existsSync } = await import("node:fs");
  rmSync(checkout, { recursive: true });
  const questions: string[] = [];
  await hosts.setup(ctx, "box", repo, async q => { questions.push(q); return false; });
  expect(questions[0]).toContain("git clone -- https://github.com/o/r.git");
  expect(existsSync(checkout)).toBe(false);
  // Keep the clone entirely local, using git's URL rewrite at process scope.
  const run = ctx.run;
  ctx.run = (argv, ms, o) => run(argv, ms, argv.at(-1)?.endsWith("clone https://github.com/o/r.git") ? { ...o, env: { ...o?.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${repo}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/o/r.git" } } : o);
  expect((await hosts.setup(ctx, "box", repo, async () => true)).ok).toBe(true);
  expect(await git(checkout, "config", "--local", "user.email")).toBe("test@example.invalid");
});

test("host clean only removes reviewed settled tasks on the selected host and preserves untransferred branches", async () => {
  const { ctx, repo, checkout, home, git } = await fixture();
  const { createTask, updateTask } = await import("../src/tasks/store");
  const { existsSync } = await import("node:fs");
  const tasks = [];
  for (const [host, state, reviewed] of [["box", "done", true], ["box", "done", false], ["box", "running", true], ["other", "done", true]] as const) {
    const t = createTask(ctx, { brief: { goal: "cleanup", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const worktree = join(home, ".pacer-remote", "worktrees", t.id), dir = join(home, ".pacer-remote", "runs", t.id, "1");
    await git(checkout, "worktree", "add", "-b", `pacer/${t.id}`, worktree);
    mkdirSync(dir, { recursive: true });
    updateTask(ctx, t.id, t => { t.state = state; if (reviewed) t.dismissed = true;
      t.run = { host, mode: "new", remoteWorktree: worktree, remoteDir: dir, workdir: worktree, dir: "unused", attempt: 1, executor: "codex@box", startedAt: 1, logFile: "unused" }; });
    tasks.push({ id: t.id, worktree, dir });
  }
  expect(await hosts.clean(ctx, "box")).toEqual({ removed: [tasks[0].id], kept: [] });
  expect(existsSync(tasks[0].worktree)).toBe(false);
  expect(existsSync(tasks[0].dir)).toBe(false);
  expect(await git(checkout, "rev-parse", "--verify", `pacer/${tasks[0].id}`)).not.toBe("");
  for (const t of tasks.slice(1)) expect(existsSync(t.worktree)).toBe(true);
});
