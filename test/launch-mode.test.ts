import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { folderKeys } from "../src/exec/claude-trust";
import { prepareInteractive } from "../src/session/reports";
import { join } from "node:path";
import { validateExecution } from "../src/config/execution";
import { validateStrategy } from "../src/config/strategy";
import { launchModeFor, MANAGED_HEADLESS } from "../src/exec/launch";
import { resumeAttempt, runAttempt } from "../src/exec/direct";
import { certifyExecutor, enforcementExclusion, resolveEnforcementTarget, STRICT_INTERACTIVE_REASON } from "../src/dispatch/enforcement";
import { resolvePolicyRepoInput } from "../src/core/project-policy";
import { registerWork } from "../src/dispatch/work";
import { runTask } from "../src/tasks/runner";
import { defaultHooks } from "../src/classify/hooks";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";

const s = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {}, cursor: {} } }, "/x");

test("launch mode defaults to interactive and execution.launch_mode switches it", () => {
  expect(launchModeFor(s.providers.codex, validateExecution(undefined))).toEqual({mode: "interactive", explicit: false});
  expect(launchModeFor(s.providers.codex, validateExecution({launch_mode: "headless"}))).toEqual({mode: "headless", explicit: false});
  expect(launchModeFor(s.providers.codex, validateExecution({launch_mode: "interactive"}))).toEqual({mode: "interactive", explicit: false});
});

test("a runner's explicit session takes precedence over execution.launch_mode", () => {
  expect(launchModeFor({...s.providers.codex, session: "headless"}, {launchMode: "interactive"})).toEqual({mode: "headless", explicit: true});
  expect(launchModeFor({...s.providers.codex, session: "interactive"}, {launchMode: "headless"})).toEqual({mode: "interactive", explicit: true});
  const strategy = validateStrategy({planner: "claude-code", accounts: {main: {kind: "claude"}}, runners: {"claude-code": {session: "headless"}}, execution: {launch_mode: "interactive"}}, "/x");
  expect(launchModeFor(strategy.providers["claude-code"], validateExecution(strategy.execution))).toEqual({mode: "headless", explicit: true});
});

test("a default-derived interactive mode falls back to headless where interactive cannot work", () => {
  const exec = validateExecution(undefined);
  expect(launchModeFor({...s.providers.codex, id: "codex@devbox"}, exec)).toEqual({mode: "headless", explicit: false, fallback: "remote runners run headless"});
  expect(launchModeFor({...s.providers.codex, id: "gemini"}, exec)).toEqual({mode: "headless", explicit: false, fallback: "no interactive launcher for gemini"});
  // An explicit interactive runner keeps today's behaviour, including its errors.
  expect(launchModeFor({...s.providers.codex, id: "gemini", session: "interactive"}, exec)).toEqual({mode: "interactive", explicit: true});
});

test("execution.launch_mode accepts interactive or headless only", () => {
  expect(validateExecution({launch_mode: "headless"}).launchMode).toBe("headless");
  expect(validateExecution({}).launchMode).toBeUndefined();
  expect(() => validateExecution({launch_mode: "pty"})).toThrow("execution.launch_mode must be interactive or headless");
  expect(() => validateStrategy({planner: "claude-code", providers: {"claude-code": {}}, execution: {launch_mode: true}}, "/x")).toThrow("execution.launch_mode must be interactive or headless");
});

function setup(name: string, script: string) {
  const bin = tmpDir();
  writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  const ctx = fakeCtx({env: {PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME}});
  const task = createTask(ctx, {brief: {goal: "Do it", repo: tmpDir()}, kind: null, requestedExecutor: null, timeoutS: 30});
  return {ctx, task};
}

test("a default-derived Codex launch below the hook-override version runs headless and records why", async () => {
  const {ctx, task} = setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "HEADLESS REPORT" > "$out"');
  ctx.run = async () => ({code: 0, stdout: "codex-cli 0.100.0", stderr: ""});
  const out = await runAttempt(ctx, s.providers.codex, task);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("launch mode: headless (codex-cli 0.100.0 is below 0.162.1 and has no per-run hook overrides)");
  expect(out.report).toEndWith("HEADLESS REPORT");
  expect(readFileSync(join(readTask(ctx, task.id)!.run!.dir, "argv"), "utf8")).toStartWith("codex exec ");
});

test("a default local task launches interactively and finishes when the agent reports", async () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const {ctx, task} = setup("codex", 'test -t 0 || exit 9; bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome done --summary "Reported result"');
  const run = ctx.run;
  ctx.run = (argv, ms, options) => argv.join(" ") === "codex --version" ? Promise.resolve({code: 0, stdout: "codex-cli 0.162.1", stderr: ""}) : run(argv, ms, options);
  updateTask(ctx, task.id, t => {t.state = "running";});
  const out = await runAttempt({...ctx, env: {...ctx.env, PACER_TEST_CLI: cli}}, s.providers.codex, task);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("Reported result");
  expect(out.report).not.toContain("launch mode:");
  const dir = readTask(ctx, task.id)!.run!.dir;
  expect(readFileSync(join(dir, "interactive.json"), "utf8")).toContain("reportToken");
  expect(readFileSync(join(dir, "argv"), "utf8")).not.toContain("codex exec");
});

test("a default Claude Code launch is pre-trusted, keeps its bypass flag and skips the bypass acknowledgement", async () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const {ctx, task} = setup("claude", 'test -t 0 || exit 9; bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome done --summary "Claude result"');
  const repo = gitRepo();
  updateTask(ctx, task.id, t => {t.state = "running"; t.brief.repo = repo; t.brief.worktreeBase = "head"; t.placement = {requested: "new"};});
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(join(ctx.home, ".claude.json"), JSON.stringify({oauthAccount: {}}), {mode: 0o600});
  const out = await runAttempt({...ctx, run: realRun, env: {...ctx.env, PACER_TEST_CLI: cli}}, s.providers["claude-code"], readTask(ctx, task.id)!);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("Claude result");
  expect(out.report).not.toContain("claude folder trust");
  const run = readTask(ctx, task.id)!.run!;
  const argv = readFileSync(join(run.dir, "argv"), "utf8");
  expect(argv).toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain(" -p ");
  const settings = JSON.parse(readFileSync(join(run.dir, "claude-settings.json"), "utf8"));
  expect(settings.skipDangerousModePermissionPrompt).toBe(true);
  // Project MCP servers are approved for this run only; the account's settings stay untouched.
  expect(settings.enableAllProjectMcpServers).toBe(true);
  expect(existsSync(join(ctx.home, ".claude", "settings.json"))).toBe(false);
  const projects = JSON.parse(readFileSync(join(ctx.home, ".claude.json"), "utf8")).projects;
  for (const key of folderKeys(run.workdir)) expect(projects[key]).toEqual({hasTrustDialogAccepted: true});
  for (const key of folderKeys(realpathSync(repo))) expect(projects[key]).toEqual({hasClaudeMdExternalIncludesWarningShown: true});
});

test("a Claude Code launch whose trust cannot be recorded still starts and says why", async () => {
  const {ctx, task} = setup("claude", 'bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome done --summary "ran"');
  updateTask(ctx, task.id, t => {t.state = "running"; t.brief.repo = gitRepo(); t.brief.worktreeBase = "head"; t.placement = {requested: "new"};});
  const out = await runAttempt({...ctx, run: realRun, env: {...ctx.env, PACER_TEST_CLI: join(import.meta.dir, "..", "src", "cli.ts")}}, s.providers["claude-code"], readTask(ctx, task.id)!);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("claude folder trust: not pre-approved (the Claude config file does not exist yet); Claude may ask whether to trust this folder");
  expect(existsSync(join(ctx.home, ".claude.json"))).toBe(false);
});

test("an in-place Claude Code run is not pre-trusted and says the trust prompt may appear", async () => {
  const {ctx, task} = setup("claude", 'bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome done --summary "ran"');
  const repo = gitRepo();
  updateTask(ctx, task.id, t => {t.state = "running"; t.brief.repo = repo; t.placement = {requested: "current", reason: "test"};});
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(join(ctx.home, ".claude.json"), JSON.stringify({oauthAccount: {}}), {mode: 0o600});
  const out = await runAttempt({...ctx, run: realRun, env: {...ctx.env, PACER_TEST_CLI: join(import.meta.dir, "..", "src", "cli.ts")}}, s.providers["claude-code"], readTask(ctx, task.id)!);
  expect(out.exec.code).toBe(0);
  expect(readTask(ctx, task.id)!.run!.mode).toBe("current");
  expect(out.report).toContain("claude folder trust: not pre-approved (only pacer-created task worktrees are); Claude may ask whether to trust this folder");
  expect(JSON.parse(readFileSync(join(ctx.home, ".claude.json"), "utf8"))).toEqual({oauthAccount: {}});
});

test("MCP servers the user rejected in the source checkout stay off in a task worktree", async () => {
  const {ctx, task} = setup("claude", 'bun "$PACER_TEST_CLI" report --task "$(basename "$(dirname "$PACER_RUN_DIR")")" --outcome done --summary "ran"');
  const repo = gitRepo();
  // Claude stores dialog answers in the untracked settings.local.json, which a new worktree does not have.
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({disabledMcpjsonServers: ["rejected", 7], enabledMcpjsonServers: ["approved", "rejected"], permissions: {allow: ["Bash"]}}));
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(join(ctx.home, ".claude.json"), JSON.stringify({oauthAccount: {}, projects: {[realpathSync(repo)]: {disabledMcpjsonServers: ["from-config"], enabledMcpjsonServers: ["also-approved"], allowedTools: ["x"]}}}), {mode: 0o600});
  updateTask(ctx, task.id, t => {t.state = "running"; t.brief.repo = repo; t.brief.worktreeBase = "head"; t.placement = {requested: "new"};});
  const out = await runAttempt({...ctx, run: realRun, env: {...ctx.env, PACER_TEST_CLI: join(import.meta.dir, "..", "src", "cli.ts")}}, s.providers["claude-code"], readTask(ctx, task.id)!);
  expect(out.exec.code).toBe(0);
  const run = readTask(ctx, task.id)!.run!;
  expect(existsSync(join(run.workdir, ".claude", "settings.local.json"))).toBe(false);
  const settings = JSON.parse(readFileSync(join(run.dir, "claude-settings.json"), "utf8"));
  expect(settings).toMatchObject({enableAllProjectMcpServers: true, disabledMcpjsonServers: ["from-config", "rejected"], enabledMcpjsonServers: ["also-approved", "approved"]});
  // Only the two MCP keys are carried; nothing else from either file.
  expect(Object.keys(settings).sort()).toEqual(["disabledMcpjsonServers", "enableAllProjectMcpServers", "enabledMcpjsonServers", "hooks", "skipDangerousModePermissionPrompt"]);
});

test("an attended Claude launch keeps Claude's own project MCP prompt; an unattended one approves all but rejected servers", () => {
  const dir = tmpDir(), launch = {argv: ["claude", "--dangerously-skip-permissions", "--", "go"], cwd: dir};
  const attended = prepareInteractive("claude-code", dir, launch, {attended: true, mcp: {enabled: ["a"], disabled: ["b"]}});
  expect(attended.argv.slice(0, 3)).toEqual(["claude", "--settings", join(dir, "claude-settings.json")]);
  const conversation = JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"));
  expect(conversation.skipDangerousModePermissionPrompt).toBe(true);
  for (const key of ["enableAllProjectMcpServers", "disabledMcpjsonServers", "enabledMcpjsonServers"]) expect(conversation).not.toHaveProperty(key);
  prepareInteractive("claude-code", dir, launch);
  expect(JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"))).toMatchObject({skipDangerousModePermissionPrompt: true, enableAllProjectMcpServers: true});
  expect(JSON.parse(readFileSync(join(dir, "claude-settings.json"), "utf8"))).not.toHaveProperty("disabledMcpjsonServers");
});

test("an agent without an interactive launcher runs headless with the reason in the attempt note", async () => {
  const {ctx, task} = setup("cursor-agent", "exit 0");
  const out = await runAttempt(ctx, {...s.providers.codex, id: "gemini"}, task);
  expect(out.exec.code).toBe(127);
  expect(out.report).toContain("launch mode: headless (no interactive launcher for gemini)");
  expect(out.report).toContain('no launcher for provider "gemini"');
});

test("execution.launch_mode headless launches the non-interactive CLI without a fallback note", async () => {
  const {ctx, task} = setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "DONE" > "$out"');
  mkdirSync(ctx.pacerHome, {recursive: true});
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution:\n  launch_mode: headless\n");
  let versionChecked = false;
  const run = ctx.run;
  ctx.run = async (argv, ...rest) => { if (argv[0] === "codex") versionChecked = true; return run(argv, ...rest); };
  const out = await runAttempt(ctx, s.providers.codex, task);
  expect(out.exec.code).toBe(0);
  expect(out.report).not.toContain("launch mode:");
  expect(versionChecked).toBe(false);
});

test("strict enforcement targets resolve the launch mode by the same precedence as the attempt", async () => {
  const ctx = fakeCtx(), binary = join(ctx.home, "claude-bin");
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(binary, "claude");
  ctx.which = name => name === "claude" ? binary : null;
  ctx.run = async () => ({code: 0, stdout: "2.1.281 (Claude Code)", stderr: ""});
  const base = {planner: "codex", accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex"}}};
  // Managed work stays headless unless the runner itself asks for interactive.
  const derived = validateStrategy({...base, runners: {"claude-code": {}}}, "/x");
  expect((await resolveEnforcementTarget(ctx, derived, "claude-code", tmpDir())).launchMode).toBe("headless");
  expect(await enforcementExclusion(ctx, derived, "claude-code", tmpDir())).toBe("Native subagent control has not been verified");
  const configured = await resolveEnforcementTarget(ctx, validateStrategy({...base, runners: {"claude-code": {}}, execution: {launch_mode: "headless"}}, "/x"), "claude-code", tmpDir());
  expect(configured.launchMode).toBe("headless");
  expect(configured.launchArgs).toContain("-p");
  const explicit = await resolveEnforcementTarget(ctx, validateStrategy({...base, runners: {"claude-code": {session: "interactive"}}, execution: {launch_mode: "headless"}}, "/x"), "claude-code", tmpDir());
  expect(explicit.launchMode).toBe("interactive");
  expect(await enforcementExclusion(ctx, validateStrategy({...base, runners: {"claude-code": {session: "interactive"}}}, "/x"), "claude-code", tmpDir())).toBe(STRICT_INTERACTIVE_REASON);
});

test("managed dispatch keeps a default-derived launch mode headless", () => {
  expect(launchModeFor(s.providers.codex, validateExecution(undefined), {managed: true})).toEqual({mode: "headless", explicit: false, fallback: MANAGED_HEADLESS});
  expect(launchModeFor(s.providers.codex, validateExecution({launch_mode: "headless"}), {managed: true})).toEqual({mode: "headless", explicit: false});
  expect(launchModeFor({...s.providers.codex, session: "interactive"}, validateExecution(undefined), {managed: true})).toEqual({mode: "interactive", explicit: true});
});

test("strict managed work on an explicitly interactive runner fails at once with the setting to change", async () => {
  const ctx = fakeCtx({now: Date.now() / 1000}), repo = tmpDir(), binary = join(ctx.home, "codex-bin");
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(binary, "codex");
  ctx.which = name => name === "codex" ? binary : null;
  const run = ctx.run;
  ctx.run = (argv, ms, options) => argv[0] === binary ? Promise.resolve({code: 0, stdout: "codex-cli 0.164.0", stderr: ""}) : run(argv, ms, options);
  const strategy = validateStrategy({planner: "claude-code", accounts: {"claude-code": {kind: "claude"}, codex: {kind: "codex", usage: "unmetered"}}, runners: {codex: {session: "interactive", models: [{id: "provider/deep", tier: "frontier"}]}}}, "test");
  const task = createTask(ctx, {brief: {goal: "debug", repo}, kind: "debug", requestedExecutor: null, timeoutS: 60});
  registerWork(ctx, task.id);
  const result = await runTask(ctx, task.id, {loadStrategy: () => strategy, hooks: defaultHooks,
    computeStatus: async statusCtx => ({generatedAt: statusCtx.now, strategy: "test", planner: "claude-code", mode: "normal", disabled: false, calendarPace: false,
      providers: [{id: "codex", usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false}], executors: {ranked: [], excluded: []}}),
    runAttempt: async () => { throw Error("an uncertifiable interactive launch started"); }, verifyRepo: async () => ({files: ""})});
  expect(result.state).toBe("failed");
  expect(result.queue).toBeUndefined();
  expect(result.result?.report).toContain(`codex: ${STRICT_INTERACTIVE_REASON}`);
});

async function strictWork(order: string[], requestedExecutor: string | null = null, certified = false) {
  const ctx = fakeCtx({now: Date.now() / 1000}), repo = tmpDir(), codex = join(ctx.home, "codex-bin"), claude = join(ctx.home, "claude-bin");
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(codex, "codex");
  writeFileSync(claude, "claude");
  ctx.which = name => name === "codex" ? codex : name === "claude" ? claude : null;
  const run = ctx.run;
  ctx.run = (argv, ms, options) => argv[0] === codex ? Promise.resolve({code: 0, stdout: "codex-cli 0.164.0", stderr: ""})
    : argv[0] === claude ? Promise.resolve({code: 0, stdout: "2.1.281 (Claude Code)", stderr: ""}) : run(argv, ms, options);
  // codex asks for interactive; claude-code resolves headless by default but is not yet certified.
  const runners = Object.fromEntries(order.map(id => [id, id === "codex" ? {session: "interactive", models: [{id: "provider/deep", tier: "frontier"}]} : {models: [{id: "provider/deep2", tier: "frontier"}]}]));
  const strategy = validateStrategy({planner: "cursor", accounts: {cursor: {kind: "cursor"}, "claude-code": {kind: "claude", usage: "unmetered"}, codex: {kind: "codex", usage: "unmetered"}}, runners}, "test");
  if (certified) await certifyExecutor(ctx, await resolveEnforcementTarget(ctx, strategy, "claude-code", (await resolvePolicyRepoInput(ctx, repo)).path), async () => ({attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"]}));
  const task = createTask(ctx, {brief: {goal: "debug", repo}, kind: "debug", requestedExecutor, timeoutS: 60});
  registerWork(ctx, task.id);
  return runTask(ctx, task.id, {loadStrategy: () => strategy, hooks: defaultHooks,
    computeStatus: async statusCtx => ({generatedAt: statusCtx.now, strategy: "test", planner: "cursor", mode: "normal", disabled: false, calendarPace: false,
      providers: order.map(id => ({id, usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false})), executors: {ranked: [], excluded: []}}) as never,
    runAttempt: async () => { throw Error("an uncertified launch started"); }, verifyRepo: async () => ({files: ""})});
}

test("strict work keeps waiting while another runner could still be certified, in any runner order", async () => {
  for (const order of [["codex", "claude-code"], ["claude-code", "codex"]]) {
    const result = await strictWork(order);
    expect(result.state).toBe("queued");
    expect(result.queue?.detail).toBe("claude-code: Native subagent control has not been verified");
  }
});

test("strict work waits when a certified headless runner is only out of reservation capacity", async () => {
  const ctx = fakeCtx({now: Date.now() / 1000}), repo = tmpDir(), codex = join(ctx.home, "codex-bin"), claude = join(ctx.home, "claude-bin");
  mkdirSync(ctx.home, {recursive: true});
  writeFileSync(codex, "codex");
  writeFileSync(claude, "claude");
  ctx.which = name => name === "codex" ? codex : name === "claude" ? claude : null;
  const run = ctx.run;
  ctx.run = (argv, ms, options) => argv[0] === codex ? Promise.resolve({code: 0, stdout: "codex-cli 0.164.0", stderr: ""})
    : argv[0] === claude ? Promise.resolve({code: 0, stdout: "2.1.281 (Claude Code)", stderr: ""}) : run(argv, ms, options);
  const strategy = validateStrategy({planner: "cursor", accounts: {cursor: {kind: "cursor"}, "claude-code": {kind: "claude", usage: "unmetered"}, codex: {kind: "codex", usage: "unmetered"}},
    runners: {codex: {models: [{id: "provider/deep", tier: "frontier"}]}, "claude-code": {session: "headless", models: [{id: "provider/deep2", tier: "frontier"}]}}}, "test");
  const resolved = await resolvePolicyRepoInput(ctx, repo);
  await certifyExecutor(ctx, await resolveEnforcementTarget(ctx, strategy, "claude-code", resolved.path), async () => ({attempted: true, blocked: true, childStarted: false, entries: ["Agent", "Task"]}));
  // A root that allows one running child, with one child already queued, refuses the sibling a reservation.
  const root = createTask(ctx, {brief: {goal: "root", repo}, kind: "debug", requestedExecutor: null, timeoutS: 60});
  registerWork(ctx, root.id, {maxConcurrent: 1, allowDelegation: true});
  updateTask(ctx, root.id, t => {t.state = "running";});
  const child = createTask(ctx, {brief: {goal: "child", repo}, kind: "debug", requestedExecutor: null, timeoutS: 60});
  registerWork(ctx, child.id, {}, root.id);
  updateTask(ctx, child.id, t => {t.state = "queued";});
  const sibling = createTask(ctx, {brief: {goal: "sibling", repo}, kind: "debug", requestedExecutor: null, timeoutS: 60});
  registerWork(ctx, sibling.id, {}, root.id);
  const result = await runTask(ctx, sibling.id, {loadStrategy: () => strategy, hooks: defaultHooks,
    computeStatus: async statusCtx => ({generatedAt: statusCtx.now, strategy: "test", planner: "cursor", mode: "normal", disabled: false, calendarPace: false,
      providers: ["codex", "claude-code"].map(id => ({id, usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false})), executors: {ranked: [], excluded: []}}) as never,
    runAttempt: async () => { throw Error("launched without a reservation"); }, verifyRepo: async () => ({files: ""})});
  expect(result.state).toBe("queued");
  expect(result.queue?.reason).toBe("waiting_retry");
  expect(result.queue?.detail).not.toContain(STRICT_INTERACTIVE_REASON);
});

test("strict work requested on an explicitly interactive runner fails at once and is not moved to another runner", async () => {
  for (const certified of [false, true]) {
    const result = await strictWork(["codex", "claude-code"], "codex", certified);
    expect(result.state).toBe("failed");
    expect(result.result?.report).toBe(`codex: ${STRICT_INTERACTIVE_REASON}`);
    expect(result.attempts).toEqual([]);
  }
});

test("an explicit interactive launch under strict enforcement is refused at launch time", async () => {
  const {ctx, task} = setup("codex", "exit 0");
  const out = await runAttempt({...ctx, env: {...ctx.env, PACER_ENFORCEMENT_MODE: "strict"}}, {...s.providers.codex, session: "interactive"}, task);
  expect(out.exec.code).toBe(1);
  expect(out.report).toContain(STRICT_INTERACTIVE_REASON);
  expect(readTask(ctx, task.id)!.run).toBeUndefined();
});

test("a strict attempt with a default-derived launch mode runs headless and records why", async () => {
  const {ctx, task} = setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "MANAGED" > "$out"');
  let versionChecked = false;
  const run = ctx.run;
  ctx.run = async (argv, ...rest) => { if (argv[0] === "codex") versionChecked = true; return run(argv, ...rest); };
  const out = await runAttempt({...ctx, env: {...ctx.env, PACER_ENFORCEMENT_MODE: "strict"}}, s.providers.codex, task);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain(`launch mode: headless (${MANAGED_HEADLESS})`);
  expect(out.report).toEndWith("MANAGED");
  expect(versionChecked).toBe(false);
  expect(readFileSync(join(readTask(ctx, task.id)!.run!.dir, "argv"), "utf8")).toStartWith("codex exec ");
});

test("a Codex version that cannot be read falls back with that reason, not as too old", async () => {
  const {ctx, task} = setup("codex", 'out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done; cat >/dev/null; echo "HEADLESS" > "$out"');
  ctx.run = async () => ({code: 0, stdout: "codex-cli 0.170.0-alpha.1", stderr: ""});
  const out = await runAttempt(ctx, s.providers.codex, task);
  expect(out.report).toContain('launch mode: headless (could not verify codex-cli version (unrecognized output "codex-cli 0.170.0-alpha.1"))');
  expect(out.report).not.toContain("below 0.162.1");
  const missing = setup("codex", "exit 0");
  missing.ctx.run = async () => ({code: 127, stdout: "", stderr: `codex: command not found\n${"x".repeat(500)}`, timedOut: false});
  expect((await runAttempt(missing.ctx, s.providers.codex, missing.task)).report).toContain("launch mode: headless (could not verify codex-cli version (codex --version exited 127: codex: command not found))");
});

test("resuming an attempt follows the recorded interactive run, not today's launch mode", async () => {
  const {ctx, task} = setup("codex", "exit 0"), dir = tmpDir(), startedAt = Date.now() / 1000 - 10;
  const run = {dir, attempt: 1, executor: "codex", startedAt, mode: "current" as const, workdir: task.brief.repo, logFile: join(dir, "log")};
  for (const [name, value] of Object.entries({pid: "999999999", "interactive.json": "{}", stdout: "terminal noise", stderr: "", exit: "0",
    "report.json": JSON.stringify({status: "done", summary: "Interactive result", source: "agent", at: Date.now() / 1000})})) writeFileSync(join(dir, name), value);
  updateTask(ctx, task.id, t => {t.state = "running"; t.run = run; t.attemptStartedAt = startedAt;});
  const out = await resumeAttempt(ctx, {...s.providers.codex, session: "headless"}, readTask(ctx, task.id)!);
  expect(out.exec.code).toBe(0);
  expect(out.report).toContain("Interactive result");
  expect(out.report).not.toContain("terminal noise");
});
