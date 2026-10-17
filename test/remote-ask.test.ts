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
  const program = `#!/bin/sh\ncat > PROMPT.txt\nenv | sort | grep -E '^(CODEX_HOME|CLAUDE_CONFIG_DIR|PACER_ROLE|PACER_TASK_ID)='\nprintf '%s' 'which db? $(rm -rf ~)' > .pacer-question\ngit add PROMPT.txt\ngit commit -q -m result\nwhile [ "$#" -gt 0 ]; do if [ "$1" = '-o' ]; then shift; printf 'final report' > "$1"; fi; shift; done\necho done\n`;
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

test("remote question is received verbatim and task id reaches the host",async()=>{
 const f=await setup();
 const result=await runAttempt(f.ctx,f.cfg,f.task);
 expect(result.exec.stdout).toContain("PACER_TASK_ID="+f.task.id);
 expect(readTask(f.ctx,f.task.id)?.question?.text).toBe('which db? $(rm -rf ~)');
 expect(result.partial).toBeUndefined();
 expect(result.worktree).toBeDefined();
 const prompt=readFileSync(join(readTask(f.ctx,f.task.id)!.run!.remoteDir!,"stdin"),"utf8");
 expect(prompt).toContain(".pacer-question");
 expect(prompt).not.toContain('run pacer ask');
},15000);
