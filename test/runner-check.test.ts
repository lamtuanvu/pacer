import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRunner, readRunnerCheck, type RunnerCheckDeps } from "../src/core/runner-check";
import { runTestTask } from "../src/endpoints/test-task";
import { callOp } from "../src/api/ops";
import { getJob, registerJobDaemon } from "../src/jobs/registry";
import { fakeCtx } from "./helpers";

function setup() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code", accounts: {claude: {kind: "claude"}, team: {kind: "codex", home: join(ctx.home, "team")}, cursor: {kind: "cursor"}}, runners: {"codex#team": {}}, routing: [{default: ["codex#team"]}]}));
  return ctx;
}
function deps(): RunnerCheckDeps {
  return {
    detectAgents: async () => [{agent: "codex", found: true, version: "1.0", path: "/bin/codex", install_hint: "install codex"}],
    listAccounts: async () => [{name: "team", signedIn: null}, {name: "cursor", signedIn: null}],
    checkLimits: async () => [{account: "team", kind: "codex", source: "session-log", capturedAt: 1, ageS: 0, stale: false, verdict: "OK", usedPct: 3, window: "weekly", resetsAt: null, runners: ["codex#team"], error: null, hint: null}],
    runTestTask: async () => {},
  };
}
test("readiness passes all four steps and persists the last result", async () => {
  const ctx = setup();
  expect(readRunnerCheck(ctx, "codex#team")).toBeNull();
  const job = await checkRunner(ctx, "codex#team", deps());
  expect(job).toMatchObject({kind: "runner.check", target: "codex#team", state: "passed"});
  expect(job.steps).toEqual([
    {name: "CLI found", state: "passed", detail: "Codex on this Mac"},
    {name: "Signed in", state: "passed", detail: "Account team"},
    {name: "Usage readable", state: "passed", detail: "Weekly window · 3% used"},
    {name: "Test task", state: "passed", detail: "Write and run a one-line test in a scratch worktree"},
  ]);
  expect(readRunnerCheck(ctx, "codex#team")).toMatchObject({at: ctx.now, passed: true});
  expect(JSON.parse(readFileSync(join(ctx.pacerHome, "state/runner-checks.json"), "utf8"))["codex#team"].passed).toBe(true);
});
for (const failure of ["cli", "signin", "usage", "task"] as const) test(`readiness records ${failure} failure and skips later steps`, async () => {
  const ctx = setup(), d = deps(); let launched = false;
  if (failure === "cli") d.detectAgents = async () => [];
  if (failure === "signin") d.listAccounts = async () => [{name: "team", signedIn: false}];
  if (failure === "usage") {const rows = await d.checkLimits!(ctx); d.checkLimits = async () => [{...rows[0], error: "usage unavailable"}];}
  d.runTestTask = async () => {launched = true; throw Error("test task failed");};
  const job = await checkRunner(ctx, "codex#team", d);
  expect(job.state).toBe("failed");
  expect(job.steps.some(s => s.state === "failed")).toBe(true);
  expect(readRunnerCheck(ctx, "codex#team")).toMatchObject({passed: false, detail: expect.any(String)});
  expect(launched).toBe(failure === "task");
});
test("no usage accounts pass with an explicit unmetered detail", async () => {
  const ctx = setup(), d = deps();
  d.checkLimits = async () => [{...(await deps().checkLimits!(ctx))[0], usedPct: null, window: null}];
  expect((await checkRunner(ctx, "codex#team", d)).steps[2].detail).toBe("no limit reported");
  // A cursor account has reactive usage rather than a usage reader.
  await callOp(ctx, "runner.add", {agent: "cursor", test: false});
  d.detectAgents = async () => [{agent: "cursor", found: true, version: null, path: "/bin/cursor", install_hint: "install cursor"}];
  d.checkLimits = async () => [];
  expect((await checkRunner(ctx, "cursor", d)).state).toBe("passed");
});
test("shared test task launches only under scratch and cleans up", async () => {
  const ctx = setup(); let cwd = "";
  await runTestTask(ctx, "codex#team", {spawn: async spec => {
    cwd = spec.cwd;
    expect(cwd.startsWith(join(ctx.pacerHome, "scratch") + "/")).toBe(true);
    expect(existsSync(join(cwd, ".git"))).toBe(true);
    expect(spec.argv[0]).toBe("codex");
    writeFileSync(join(cwd, "hello.txt"), "ok");
    return {code: 0, stdout: "", stderr: "", timedOut: false};
  }});
  expect(existsSync(cwd)).toBe(false);
});
test("runner.check and runner.add return jobs, including daemon background work", async () => {
  const ctx = setup(), d = deps();
  expect(await callOp(ctx, "runner.check", {id: "codex#team"}, {runnerCheck: d})).toMatchObject({kind: "runner.check", state: "passed"});
  const releaseDaemon = registerJobDaemon(ctx); let finish!: () => void;
  const waiting = new Promise<void>(resolve => {finish = resolve;});
  const result = await callOp(ctx, "runner.add", {agent: "cursor", test: true}, {runnerCheck: {...d,
    detectAgents: async () => [{agent: "cursor", found: true, version: null, path: "/bin/cursor", install_hint: "install"}],
    runTestTask: async () => waiting,
  }}) as {id: string; job: {id: string; state: string}};
  expect(result).toMatchObject({id: "cursor", job: {kind: "runner.check", state: "running"}});
  finish();
  for (let i = 0; i < 100 && getJob(ctx, result.job.id).state === "running"; i++) await Bun.sleep(5);
  releaseDaemon();
  expect(getJob(ctx, result.job.id).state).toBe("passed");
  expect(readRunnerCheck(ctx, "codex#team")?.passed).toBe(true);
  expect(readRunnerCheck(ctx, "cursor")?.passed).toBe(true);
});
test("readiness uses real account and limits readers and the shared launcher", async () => {
  const ctx = setup(), sessions = join(ctx.home, "team/sessions");
  mkdirSync(sessions, {recursive: true});
  writeFileSync(join(sessions, "rollout-test.jsonl"), JSON.stringify({rate_limits: {primary: {used_percent: 3, window_minutes: 10080}}}) + "\n");
  // Signed in: the login indicator only checks that Codex wrote its auth file.
  writeFileSync(join(ctx.home, "team/auth.json"), "{}");
  let repo = "";
  const job = await checkRunner(ctx, "codex#team", {runTestTask: (ctx, id) => runTestTask(ctx, id, {spawn: async spec => {
    repo = spec.cwd;
    writeFileSync(join(repo, "hello.txt"), "ok");
    return {code: 0, stdout: "", stderr: "", timedOut: false};
  }})});
  expect(job.state).toBe("passed");
  expect(job.steps[2]).toMatchObject({state: "passed", detail: "Weekly window · 3% used"});
  expect(existsSync(repo)).toBe(false);
});
test("failed shared test tasks are cleaned and secrets stay out of jobs and results", async () => {
  const ctx = setup(); ctx.env.TEST_TOKEN = "private-readiness-value";
  const d = deps(); let repo = "";
  d.runTestTask = (ctx, id) => runTestTask(ctx, id, {spawn: async spec => {
    repo = spec.cwd;
    return {code: 1, stdout: "", stderr: `failure ${ctx.env.TEST_TOKEN}\nprivate second line`, timedOut: false};
  }});
  const job = await checkRunner(ctx, "codex#team", d);
  expect(job.state).toBe("failed");
  expect(existsSync(repo)).toBe(false);
  const stored = JSON.stringify({job: getJob(ctx, job.id), check: readRunnerCheck(ctx, "codex#team")});
  expect(stored).not.toContain("private-readiness-value");
  expect(stored).not.toContain("private second line");
  expect(job.steps[3].state).toBe("failed");
});
