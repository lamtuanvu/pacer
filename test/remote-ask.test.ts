import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAttempt, resumeAttempt } from "../src/exec/direct";
import { loadStrategy } from "../src/config/strategy";
import { taskWorktreePath } from "../src/supervisor/worktree";
import { runTask } from "../src/tasks/runner";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { receiveQuestion } from "../src/remote/transfer";
import { consumePersistedQuestion, issuePersistedQuestion, questionBlobHash, validatePersistedQuestion } from "../src/plugins/question-issuer";
import { SCRIPTS } from "../src/remote/scripts";
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
  const ctx = fakeCtx({ env, which: name => name === "ssh" ? join(import.meta.dir, "fixtures", "bin", "ssh") :
    name === "git" ? "/usr/bin/git" : Bun.which(name), run: (argv, ms, o) => {
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
  const task = createTask(ctx, { brief: { goal, repo, base: "main" }, kind: "feature", requestedExecutor: id, timeoutS: 30 });
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
 expect(readFileSync(join(readTask(f.ctx,f.task.id)!.run!.remoteWorktree!,".pacer-question"),"utf8"))
   .toBe('which db? $(rm -rf ~)');
},60000);

test("accepted question is not cleared when the remote file changes", async () => {
 const f=await setup();
 await runAttempt(f.ctx,f.cfg,f.task);
 const task=readTask(f.ctx,f.task.id)!, run=task.run!, path=join(run.remoteWorktree!,".pacer-question");
 writeFileSync(path,"a different question");
 const host=loadStrategy(f.ctx).hosts.box!;
 await expect(receiveQuestion(f.ctx,task,host,run)).rejects.toThrow("changed after task acceptance");
 expect(readFileSync(path,"utf8")).toBe("a different question");
},60000);

test("crash retry keeps the accepted question and preflight rejects changed bytes", async () => {
 const f=await setup();
 await runAttempt(f.ctx,f.cfg,f.task);
 const task=readTask(f.ctx,f.task.id)!, run=task.run!, path=join(run.remoteWorktree!,".pacer-question");
 const host=loadStrategy(f.ctx).hosts.box!, accepted=task.question!.text;
 await receiveQuestion(f.ctx,task,host,run);
 expect(readTask(f.ctx,task.id)?.question?.text).toBe(accepted);
 expect(readFileSync(path,"utf8")).toBe(accepted);
 const preflight=async()=>realRun(["bash","-c",SCRIPTS.PREFLIGHT,"pacer",
   run.remoteWorktree!,run.baseSha!,run.remoteBranch!,questionBlobHash(accepted,"sha1"),
   questionBlobHash(accepted,"sha256")],10000);
 const same=await preflight();
 expect(same.code).toBe(0);
 expect(same.stdout).toContain("dirty=0\n");
 writeFileSync(path,"replacement question");
 const changed=await preflight();
 expect(changed.code).toBe(0);
 expect(changed.stdout).toContain("dirty=1\n");
 expect(readFileSync(path,"utf8")).toBe("replacement question");
 // Reproduce a replacement after preflight's hash read. Even if the old hash
 // is returned, observation must not remove the newly written question.
 writeFileSync(path,accepted);
 const bin=join(f.hostHome,"hash-race-bin");mkdirSync(bin);
 writeFileSync(join(bin,"git"),`#!/bin/sh
if [ "$1" = hash-object ] && [ ! -f "$PACER_TEST_RACE_MARKER" ]; then
  printf '%s' "$PACER_TEST_ACCEPTED_HASH"
  printf '%s' 'late replacement' > "$PACER_TEST_QUESTION_FILE"
  : > "$PACER_TEST_RACE_MARKER"
  exit 0
fi
exec /usr/bin/git "$@"
`,{mode:0o755});
 const raced=await realRun(["bash","-c",SCRIPTS.PREFLIGHT,"pacer",run.remoteWorktree!,
   run.baseSha!,run.remoteBranch!,questionBlobHash(accepted,"sha1"),questionBlobHash(accepted,"sha256")],10000,{env:{
     PATH:`${bin}:${process.env.PATH}`,PACER_TEST_ACCEPTED_HASH:questionBlobHash(accepted),
     PACER_TEST_QUESTION_FILE:path,PACER_TEST_RACE_MARKER:join(bin,"replaced") }});
 expect(raced.code).toBe(0);
 expect(raced.stdout).toContain("dirty=1\n");
 expect(readFileSync(path,"utf8")).toBe("late replacement");
},60000);

test("question grants are pinned to the persisted revision and one use", async () => {
 const f=await setup();
 await runAttempt(f.ctx,f.cfg,f.task);
 const task=readTask(f.ctx,f.task.id)!, run=task.run!;
 const read=issuePersistedQuestion(f.ctx,task.id,run.attempt);
 validatePersistedQuestion(f.ctx,read);
 consumePersistedQuestion(f.ctx,read);
 expect(()=>consumePersistedQuestion(f.ctx,read)).toThrow();
 updateTask(f.ctx,task.id,t=>{ t.run!.transferredHead="a".repeat(40); });
 expect(()=>validatePersistedQuestion(f.ctx,read)).toThrow();
},60000);
