import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, withLoginIndicators, tmpDir } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function setup(executors: Record<string, string>, strategy: string, inheritedEnv = process.env) {
  const home = tmpDir();
  withLoginIndicators(fakeCtx({ home }));
  const pacerHome = join(home, ".pacer");
  mkdirSync(pacerHome, { recursive: true });
  // These stubs model headless CLIs, so pin the launch mode rather than take the interactive default.
  writeFileSync(join(pacerHome, "strategy.yaml"), `${strategy}execution:\n  launch_mode: headless\n`);
  const bin = join(home, "bin");
  mkdirSync(bin);
  // Direct-backend fixtures must not read the host Orca account budgets.
  for (const [name, body] of Object.entries({ orca: "exit 127", ...executors })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const repo = join(home, "repo");
  mkdirSync(repo);
  // Routing's login indicator honors CODEX_HOME before HOME. Keep it with the
  // fixture's fake auth file even when the invoking shell selects another account.
  const env = { ...inheritedEnv, HOME: home, CODEX_HOME: join(home, ".codex"), PACER_HOME: pacerHome, PACER_BACKEND: "direct", PATH: `${bin}:${inheritedEnv.PATH}`, TZ: "Asia/Ho_Chi_Minh" };
  Bun.spawnSync(["sh", "-c", "git init -q -b main && git remote add origin . && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init"], { cwd: repo, env });
  return { repo, env, pacerHome };
}

function delegateWait(env: Record<string, string | undefined>, repo: string, extra: string[] = []) {
  const p = Bun.spawnSync(["bun", CLI, "delegate", "--repo", repo, "--goal", "Create fixed.txt", "--acceptance", "test -f fixed.txt", "--wait", "--json", ...extra], { env, cwd: repo });
  return { code: p.exitCode, task: JSON.parse(p.stdout.toString()), stderr: p.stderr.toString() };
}

const CODEX_OK = 'case " $* " in *" app-server "*) printf \'{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":1,"windowDurationMins":10080,"resetsAt":2000000000}}}}\\n\'; exit 0;; esac; out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo hi > fixed.txt; echo "Created fixed.txt; acceptance passes." > "$out"';

test("delegate --wait runs codex through a detached runner and verifies the result", () => {
  const { repo, env } = setup({ codex: CODEX_OK }, "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n", { ...process.env, CODEX_HOME: tmpDir(), OPENAI_API_KEY: "", CODEX_API_KEY: "" });
  const r = delegateWait(env, repo);
  expect(r.code).toBe(0);
  expect(r.task.state).toBe("done");
  expect(r.task.result).toMatchObject({ status: "done", executor: "codex", backend: "direct" });
  expect(r.task.result.report).toMatch(/^ran in new worktree \S+ \(strategy default\)\n\nCreated fixed\.txt; acceptance passes\.$/);
  expect(r.task.result.files).toContain("untracked: fixed.txt");
  expect(r.task.result.acceptance.passed).toBe(true);
}, 30_000);

test("codex limit falls back to cursor and marks codex exhausted", () => {
  const { repo, env, pacerHome } = setup({
    codex: 'cat >/dev/null; echo "Error: rate limit reached" >&2; exit 1',
    "cursor-agent": "echo hi > fixed.txt; echo cursor done",
  }, "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n  cursor: {}\n");
  const r = delegateWait(env, repo);
  expect(r.task.result).toMatchObject({ status: "done", executor: "cursor" });
  expect(r.task.attempts.map((a: { executor: string }) => a.executor)).toEqual(["codex", "cursor"]);
  expect(JSON.parse(readFileSync(join(pacerHome, "exhausted.json"), "utf8")).codex).toBeGreaterThan(Date.now() / 1000);
}, 30_000);

 test("CLI placement flags reach the detached runner",()=>{
 for(const worktree of ["current","new"]){
 const {repo,env}=setup({codex:CODEX_OK},"planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
 const r=delegateWait(env,repo,["--worktree",worktree,"--worktree-reason","installed dependencies"]);
 expect(r.code).toBe(0);expect(r.task.placement).toEqual({requested:worktree,reason:"installed dependencies",mode:worktree,why:"agent: installed dependencies"});
 expect(r.task.result.report).toStartWith(worktree === "new" ? "ran in new worktree " : "ran in current worktree (agent: installed dependencies)");
 expect(r.task.result.report.includes("worktree isolation needs the Orca backend")).toBe(false);
 }
 },30000);
