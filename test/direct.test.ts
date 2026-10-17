import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import { runAttempt, tail } from "../src/exec/direct";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/x");

// Wrapper identity checks require ps, which restricted test environments may deny.
const canInspectProcesses = (() => {try {return Bun.spawnSync(["ps", "-p", String(process.pid)]).exitCode === 0;} catch {return false;}})();
test.skipIf(!canInspectProcesses)("progress is recorded while the agent runs, and a silent agent is stopped as idle", async () => {
  const { ctx, task } = await setup("cursor-agent", "echo start; sleep 30", { git: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  cursor: {}\nexecution:\n  idle_after_min: 1\n  idle_fail_min: 2\n");
  const o = await runAttempt({ ...ctx, env: { ...ctx.env, PACER_IDLE_SCALE: "0.01" } }, s.providers.cursor, task);
  expect(o.exec.code).toBe(143);
  expect(o.exec.stderr).toContain("without output or file changes");
  const p = readTask(ctx, task.id)!.progress!;
  expect(p.logBytes).toBeGreaterThan(0);
  expect(["working", "idle"]).toContain(p.phase);
});

function fakeBin(name: string, script: string): string {
  const dir = tmpDir();
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  return dir;
}

async function setup(name: string, script: string, o: { git?: boolean } = {}) {
  const bin = fakeBin(name, script);
  const repo = o.git ? gitRepo() : tmpDir();
  const ctx = fakeCtx({ ...(o.git ? { run: realRun } : {}), env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME } });
  const task = createTask(ctx, { brief: { goal: "Do it", repo }, kind: null, requestedExecutor: null, timeoutS: 30 });
  return { ctx, task, repo };
}

test("codex: report comes from the -o last-message file; attempt recorded", async () => {
  const { ctx, task } = await setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "FINAL REPORT" > "$out"; echo noisy');
  let spawned = 0;
  const o = await runAttempt(ctx, s.providers.codex, task, (pid) => { spawned = pid; });
  expect(spawned).toBeGreaterThan(0);
  expect(o.exec.code).toBe(0);
  expect(o.report).toEndWith("FINAL REPORT");
  expect(o.report).toStartWith("ran in place: ");
  expect(o.attempt).toMatchObject({ executor: "codex", model: null, exitCode: 0, timedOut: false, limitHit: false });
  expect(await Bun.file(o.attempt.log).exists()).toBe(true);
});

test("cursor: report is the stdout tail; limit output marks limitHit", async () => {
  const { ctx, task } = await setup("cursor-agent", 'echo "You have hit your usage limit"; exit 1');
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.report).toContain("usage limit");
  expect(o.attempt.limitHit).toBe(true);
});

test("launcher error becomes a failed attempt instead of throwing", async () => {
  const { ctx, task } = await setup("x", "true");
  const o = await runAttempt(ctx, { ...s.providers.codex, id: "gemini" }, task);
  expect(o.exec.code).toBe(127);
  expect(o.report).toContain('no launcher for provider "gemini"');
  expect(o.attempt.exitCode).toBe(127);
});

test("fallback reuses the worktree after a launcher fails before recording a run", async () => {
  const { ctx, task } = await setup("cursor-agent", "test -f prior.txt && echo fallback; echo done > made.txt", { git: true });
  const first = await runAttempt(ctx, { ...s.providers.codex, id: "gemini" }, task);
  expect(first.exec.code).toBe(127);
  const saved = readTask(ctx, task.id)!;
  expect(saved.run).toBeUndefined();
  expect(saved.baseBranch).toBe("main");
  writeFileSync(join(saved.worktree!, "prior.txt"), "prior work");
  updateTask(ctx, task.id, t => { t.attempts.push(first.attempt); });
  const second = await runAttempt(ctx, s.providers.cursor, readTask(ctx, task.id)!);
  expect(second.exec.code).toBe(0);
  expect(second.worktree).toBe(saved.worktree);
  expect(second.report).toBe("fallback");
  expect(readFileSync(join(second.worktree!, "made.txt"), "utf8")).toBe("done\n");
});

test("tail keeps the last n characters", () => {
  expect(tail("abcdef", 3)).toBe("def");
  expect(tail("ab", 3)).toBe("ab");
});

test("executor launch sets its role while preserving the caller environment", async () => {
  const { ctx, task } = await setup("cursor-agent", 'printf "%s:%s" "$PACER_ROLE" "$CUSTOM_VALUE"');
  ctx.env.HOME = ctx.home;
  ctx.env.PACER_ROLE = "planner";
  ctx.env.CUSTOM_VALUE = "kept";
  expect((await runAttempt(ctx, s.providers.cursor, task)).report).toEndWith("executor:kept");
  expect(ctx.env.PACER_ROLE).toBe("planner");
});

 test("explicit current runs in place without the isolation note",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");task.placement={requested:"current",reason:"installed dependencies"};
 const out=await runAttempt(ctx,s.providers.cursor,task);expect(out.report).toBe("report");
 expect((await import("../src/tasks/store")).readTask(ctx,task.id)?.placement).toMatchObject({mode:"current",why:"agent: installed dependencies"});
 });

test("explicit new records actual in-place placement and isolation note",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");task.placement={requested:"new",reason:"isolation"};
 const out=await runAttempt(ctx,s.providers.cursor,task);expect(out.report).toStartWith("ran in place: ");
 expect((await import("../src/tasks/store")).readTask(ctx,task.id)).toMatchObject({worktree:task.brief.repo,placement:{requested:"new",mode:"current",why:"agent: isolation"}});
});
test("direct fallback remains available when git inspection throws",async()=>{
 const {ctx,task}=await setup("cursor-agent","echo report");ctx.run=async()=>{throw Error("git unavailable");};
 expect((await runAttempt(ctx,s.providers.cursor,task)).exec.code).toBe(0);
});

test("new placement runs in a pacer worktree on branch pacer/<task-id>; the repo itself is untouched", async () => {
  const { ctx, task, repo } = await setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo hi > made.txt; echo DONE > "$out"', { git: true });
  const o = await runAttempt(ctx, s.providers.codex, task);
  expect(o.exec.code).toBe(0);
  expect(o.worktree).toStartWith(join(ctx.pacerHome, "worktrees") + "/");
  expect(existsSync(join(o.worktree!, "made.txt"))).toBe(true);
  expect(existsSync(join(repo, "made.txt"))).toBe(false);
  expect(o.report).toBe("DONE");
  expect(readTask(ctx, task.id)).toMatchObject({ placement: { mode: "new" }, worktree: o.worktree, run: { attempt: 1, executor: "codex", mode: "new" } });
});

test("non-git repo runs in place with a note", async () => {
  const { ctx, task } = await setup("cursor-agent", "echo done");
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.report).toStartWith("ran in place: ");
  expect(o.report).toContain("not a git repository");
  expect(readTask(ctx, task.id)?.placement?.mode).toBe("current");
});

test("detached HEAD refuses new placement", async () => {
  const { ctx, task, repo } = await setup("cursor-agent", "echo done", { git: true });
  Bun.spawnSync(["git", "checkout", "-q", "--detach"], { cwd: repo });
  const o = await runAttempt(ctx, s.providers.cursor, task);
  expect(o.exec.code).toBe(1);
  expect(o.report).toContain("detached HEAD");
});

test("live output lands in the run directory while the agent runs; the legacy log is written at the end", async () => {
  const { ctx, task } = await setup("cursor-agent", "echo first; sleep 1; echo second", { git: true });
  const o = await runAttempt(ctx, s.providers.cursor, task);
  const run = readTask(ctx, task.id)!.run!;
  expect(readFileSync(join(run.dir, "stdout"), "utf8")).toBe("first\nsecond\n");
  expect(readFileSync(o.attempt.log, "utf8")).toMatch(/^\$ cursor-agent .*\n--- stdout\nfirst\nsecond\n\n--- stderr\n\n--- exit 0\n$/s);
});
for (const [agent,kind,bin,fixture] of [['claude-code','claude','claude','claude-weekly-limit.txt'],['codex','codex','codex','codex-team-limit.txt']]) test(`direct ${agent} named-account failure detects recorded limit output`,async()=>{
 const text=await Bun.file(new URL(`./fixtures/${fixture}`,import.meta.url)).text();
 const {ctx,task}=await setup(bin,`cat <<'LIMIT'\n${text}LIMIT\nexit 1`);
 const {mkdirSync}=await import('node:fs');mkdirSync(ctx.pacerHome,{recursive:true});
 const raw={accounts:{plan:{kind:'claude'},team:{kind,home:'~/.test-team'}},planner:'claude-code',routing:[{default:[`${agent}#team`]}]};
 writeFileSync(join(ctx.pacerHome,'strategy.yaml'),JSON.stringify(raw));
 const st=validateStrategy(raw,'test');
 const out=await runAttempt(ctx,st.providers[`${agent}#team`],task);
 expect(out.attempt.exitCode).toBe(1);expect(out.attempt.limitHit).toBe(true);
});

for (const status of ["done", "failed"] as const) test(`interactive ${status} attempts use explicit results and a transcript, never screen text`, async () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const {ctx, task} = await setup("codex", 'test -t 0 || exit 9; echo "You have hit your usage limit"; printf "Transcript result" > "$PACER_TRANSCRIPT_REPORT"; bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome "$PACER_TEST_STATUS" --summary "Explicit result"');
  const priorRun = ctx.run;
  ctx.run = (argv, ms, options) => argv.join(" ") === "codex --version" ? Promise.resolve({code: 0, stdout: "codex-cli 0.162.1", stderr: ""}) : priorRun(argv, ms, options);
  updateTask(ctx, task.id, t => {t.state = "running";});
  const out = await runAttempt({...ctx, env: {...ctx.env, PACER_TEST_CLI: cli, PACER_TEST_STATUS: status}}, {...s.providers.codex, session: "interactive"}, task);
  expect(out.exec.code).toBe(status === "done" ? 0 : 1);
  expect(out.report).toContain("Explicit result");
  expect(out.report).toContain("Transcript result");
  expect(out.report).not.toContain("usage limit");
  expect(out.attempt.limitHit).toBe(false);
});

test("interactive Codex refuses a runner without per-run hook support", async () => {
  const {ctx, task} = await setup("codex", 'echo should-not-launch');
  ctx.run = async () => ({code: 0, stdout: "codex-cli 0.100.0", stderr: ""});
  const out = await runAttempt(ctx, {...s.providers.codex, session: "interactive"}, task);
  expect(out.exec.code).toBe(127);
  expect(out.report).toContain("per-run hook overrides");
  expect(readTask(ctx, task.id)?.run).toBeUndefined();
});
