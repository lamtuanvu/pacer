import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderCfg, loadStrategy } from "../src/config/strategy";
import { runOwnedDirectCurrent, runOwnedDirectNew } from "../src/plugins/executor-production";
import { createCallAuthority } from "../src/plugins/authority";
import { answerOwnedRemoteOutput, answerOwnedRemotePoll, answerOwnedRemoteStart } from "../src/plugins/executor-remote-run";
import { STRICT_INTERACTIVE_REASON, certifyExecutor, planStrictClaudeLaunch, resolveEnforcementTarget, strictClaudeLaunch } from "../src/dispatch/enforcement";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { runTask } from "../src/tasks/runner";
import { registerWork } from "../src/dispatch/work";
import { sendMessage } from "../src/messaging/send";
import * as messages from "../src/messaging/store";
import { defaultHooks } from "../src/classify/hooks";
import { ensureRunnerIntegration } from "../src/core/integrations";
import { runnerEnv } from "../src/exec/launch";
import { eligibility } from "./fixtures/eligibility";
import { fakeCtx, realRun, tmpDir } from "./helpers";

/** A fake agent that answers --version and prints every argument it was launched with. */
const ECHO_AGENT = (version: string) =>
  `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version}'; exit 0; fi\nfor a in "$@"; do printf '%s\\n' "$a"; done\nexit 0\n`;

function fixture(strategy: string, agents: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "pacer-direct-parity-"));
  const pacerHome = join(home, ".pacer"), repo = join(home, "repo"), bin = join(home, "bin");
  for (const dir of [pacerHome, repo, bin]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(pacerHome, "strategy.yaml"), strategy, { mode: 0o600 });
  for (const [name, script] of Object.entries(agents)) writeFileSync(join(bin, name), script, { mode: 0o700 });
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const ctx = { ...fakeCtx({ home, pacerHome, env: { PATH: `${bin}:${process.env.PATH}` },
    which: name => Object.hasOwn(agents, name) ? join(bin, name) : null }), run: realRun };
  return { ctx, repo, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function selected(ctx: ReturnType<typeof fixture>["ctx"], repo: string, executor: string, goal = "fixture") {
  const created = createTask(ctx, { brief: { goal, repo }, kind: null, requestedExecutor: executor,
    timeoutS: 30, placement: { requested: "current" } });
  return updateTask(ctx, created.id, current => {
    current.state = "running";
    current.executor = executor;
    current.executorProvider = "pacer-exec-direct";
  });
}

const deps = (providers: string[]) => ({
  loadStrategy,
  computeStatus: async () => ({ generatedAt: Date.now() / 1000, strategy: "default", planner: "codex",
    mode: "normal" as const, disabled: false, calendarPace: true, accounts: [],
    providers: providers.map(id => ({ id, eligibility: eligibility(), usage: "quota" as const, windows: [],
      binding: null, verdict: "ON_PACE" as const, installed: true, stale: false })),
    executors: { ranked: [], excluded: [] } }),
  hooks: { ...defaultHooks, taskKind: async () => "research" },
  verifyRepo: async () => ({ files: "(no changes)" }),
});

const CODEX = ECHO_AGENT("codex-cli 0.162.1");
/** Runner-form strategy: only runners carry an explicit session. */
const runners = (agent: "codex" | "claude-code", session: string | null, execution = "{worktree: current}") => [
  "accounts:\n  codex: {kind: codex}\n  claude: {kind: claude}",
  `planner: {agent: ${agent === "codex" ? "claude-code, account: claude" : "codex, account: codex"}}`,
  `runners:\n  ${agent}: {agent: ${agent}, account: ${agent === "codex" ? "codex" : "claude"}${session ? `, session: ${session}` : ""}}`,
  `routing:\n  - default: [${agent}]`, `execution: ${execution}`, ""].join("\n");
const CLAUDE = ECHO_AGENT("2.1.281 (Claude Code)");

test("an unset launch mode resolves to the interactive default on the owned route", async () => {
  const { ctx, repo, cleanup } = fixture(
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current}\n", { codex: CODEX });
  try {
    const task = selected(ctx, repo, "codex");
    const cfg = loadStrategy(ctx).providers.codex as ProviderCfg;
    expect(cfg.session).toBeUndefined();
    await runOwnedDirectCurrent(ctx, cfg, task);
    expect(readTask(ctx, task.id)?.run?.session).toBe("interactive");
  } finally { cleanup(); }
});

test("execution.launch_mode headless keeps the owned route on a pipe launch", async () => {
  const { ctx, repo, cleanup } = fixture(
    "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\nexecution: {worktree: current, launch_mode: headless}\n",
    { codex: CODEX });
  try {
    const task = selected(ctx, repo, "codex");
    const out = await runOwnedDirectCurrent(ctx, loadStrategy(ctx).providers.codex as ProviderCfg, task);
    expect(readTask(ctx, task.id)?.run?.session).toBeUndefined();
    expect(out.exec.code).toBe(0);
  } finally { cleanup(); }
});

test("a long interactive brief becomes a host-written prompt file after the empty run claim", async () => {
  const { ctx, repo, cleanup } = fixture(
    runners("codex", "interactive"),
    { codex: CODEX });
  try {
    const goal = `long brief ${"x".repeat(40 * 1024)}`;
    const task = selected(ctx, repo, "codex", goal);
    await runOwnedDirectCurrent(ctx, loadStrategy(ctx).providers.codex as ProviderCfg, task);
    const run = readTask(ctx, task.id)!.run!, file = join(run.dir, "prompt.md");
    expect(readTask(ctx, task.id)?.startIntent?.attempt).toBe(1);
    expect(readFileSync(file, "utf8")).toContain(goal);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const session = JSON.parse(readFileSync(join(run.dir, "session.json"), "utf8")) as { argv: string[] };
    expect(session.argv.at(-1)).toBe(`Read the complete task instructions in ${JSON.stringify(file)} and carry them out.`);
  } finally { cleanup(); }
});

test("the planned strict guard matches strictClaudeLaunch byte for byte", () => {
  const ctx = fakeCtx({ env: { PACER_BIN: "/opt/pacer" } }), dir = tmpDir();
  const argv = ["claude", "-p", "--dangerously-skip-permissions", "prompt"];
  const planned = planStrictClaudeLaunch(ctx, argv, dir);
  expect(existsSync(join(dir, "strict-claude-settings.json"))).toBe(false);
  expect(strictClaudeLaunch(ctx, argv, dir)).toEqual(planned.argv);
  expect(readFileSync(join(dir, "strict-claude-settings.json"), "utf8")).toBe(planned.file.content);
});

test("a strict owned route refuses an interactive selection without a run", async () => {
  const { ctx, repo, cleanup } = fixture(
    runners("claude-code", "interactive"),
    { claude: CLAUDE });
  try {
    const task = selected(ctx, repo, "claude-code");
    const strict = { ...ctx, env: { ...ctx.env, PACER_ENFORCEMENT_MODE: "strict" } };
    const out = await runOwnedDirectCurrent(strict, loadStrategy(ctx).providers["claude-code"] as ProviderCfg, task);
    expect(out.exec.code).toBe(1);
    expect(out.report).toBe(STRICT_INTERACTIVE_REASON);
    expect(readTask(ctx, task.id)?.run).toBeUndefined();
    expect(existsSync(join(ctx.pacerHome, "runs", task.id))).toBe(false);
  } finally { cleanup(); }
});

const STRICT_STRATEGY = (session = "") => JSON.stringify({
  planner: { agent: "codex", account: "codex" },
  accounts: { codex: { kind: "codex" }, claude: { kind: "claude", usage: "unmetered" } },
  runners: { "claude-code": { agent: "claude-code", account: "claude", ...(session ? { session } : {}),
    models: [{ id: "provider/fixture", tier: "small" }] } },
  routing: [{ default: ["claude-code"] }],
  execution: { worktree: "current" },
  dispatch: { timeoutMs: 5000, steps: [{ id: "fixture", capacity: "unknown" }] },
});

async function strictWork(session = "") {
  const f = fixture(STRICT_STRATEGY(session), { claude: CLAUDE, codex: CODEX });
  const created = createTask(f.ctx, { brief: { goal: "strict fixture", repo: f.repo }, kind: null,
    requestedExecutor: "claude-code", timeoutS: 30, placement: { requested: "current" } });
  expect(registerWork(f.ctx, created.id, {}).options.delegationEnforcement).toBe("strict");
  const certCtx = { ...f.ctx, now: Date.now() / 1000 }, strategy = loadStrategy(f.ctx);
  // Launch-time setup writes the account's Claude settings; certify the control files the attempt will see.
  await ensureRunnerIntegration(certCtx, strategy.runners["claude-code"]!);
  await runnerEnv(certCtx, strategy.runners["claude-code"]!);
  // Admission checks the registered repository by its canonical path.
  const target = await resolveEnforcementTarget(certCtx, strategy, "claude-code", realpathSync(f.repo));
  await certifyExecutor(certCtx, target, async () => ({ attempted: true, blocked: true, childStarted: false }));
  return { ...f, id: created.id };
}

test("strict managed work through the runner launches claude with the certified Agent|Task guard", async () => {
  const { ctx, id, cleanup } = await strictWork();
  try {
    const result = await runTask({ ...ctx, now: Date.now() / 1000 }, id, deps(["codex", "claude-code"]));
    expect(result.executorProvider).toBe("pacer-exec-direct");
    expect(result.attempts).toHaveLength(1);
    const run = result.run!, settings = join(run.dir, "strict-claude-settings.json");
    const argv = readFileSync(join(run.dir, "stdout"), "utf8").split("\n");
    expect(argv[argv.indexOf("--settings") + 1]).toBe(settings);
    const guard = JSON.parse(readFileSync(settings, "utf8"));
    expect(guard.hooks.PreToolUse[0].matcher).toBe("Agent|Task");
    expect(guard.hooks.PreToolUse[0].hooks[0].command).toContain("guard --planner claude-code");
    expect(run.session).toBeUndefined();
  } finally { cleanup(); }
});

test("strict managed work through the runner refuses an explicit interactive runner", async () => {
  const { ctx, id, cleanup } = await strictWork("interactive");
  try {
    const result = await runTask({ ...ctx, now: Date.now() / 1000 }, id, deps(["codex", "claude-code"]));
    expect(result.state).toBe("failed");
    expect(result.result?.report).toContain(STRICT_INTERACTIVE_REASON);
    expect(result.attempts).toHaveLength(0);
    expect(existsSync(join(ctx.pacerHome, "runs", id))).toBe(false);
  } finally { cleanup(); }
});

test("a sent message turn reaches the owned route once and resumes the native session", async () => {
  const { ctx, repo, cleanup } = fixture(runners("claude-code", "headless"), { claude: CLAUDE, codex: CODEX });
  try {
    const created = createTask(ctx, { brief: { goal: "first turn", repo }, kind: null,
      requestedExecutor: "claude-code", timeoutS: 30, placement: { requested: "current" } });
    updateTask(ctx, created.id, task => { task.origin = "external:claude-code"; });
    const first = await runTask({ ...ctx, now: Date.now() / 1000 }, created.id, deps(["codex", "claude-code"]));
    expect(first.state).toBe("done");
    expect(first.executorProvider).toBe("pacer-exec-direct");
    const session = first.run?.agentSession;
    expect(session?.source).toBe("assigned");
    const firstArgv = readFileSync(join(first.run!.dir, "stdout"), "utf8").split("\n");
    expect(firstArgv[firstArgv.indexOf("--session-id") + 1]).toBe(session!.id);

    const sent = await sendMessage({ ...ctx, env: { ...ctx.env, CLAUDECODE: "1" }, now: Date.now() / 1000 }, { to: `task:${created.id}`, body: "also handle the follow-up",
      requestId: "turn-1" }, { spawnRunner: () => 1 });
    expect(sent.delivery).toBe("turn_started");
    const turnId = readTask(ctx, created.id)!.pendingTurn!.id;
    const second = await runTask({ ...ctx, now: Date.now() / 1000 }, created.id, deps(["codex", "claude-code"]));
    expect(second.executorProvider).toBe("pacer-exec-direct");
    expect(second.attempts).toHaveLength(2);
    expect(second.run?.attempt).toBe(2);
    const turnArgv = readFileSync(join(second.run!.dir, "stdout"), "utf8").split("\n");
    expect(turnArgv[turnArgv.indexOf("--resume") + 1]).toBe(session!.id);
    expect(turnArgv.join("\n")).toContain("also handle the follow-up");
    expect(turnArgv.join("\n")).not.toContain("first turn");
    expect(second.run?.turnResume).toBeUndefined();
    const claimed = messages.claimedMessages(ctx, turnId);
    expect(claimed.map(m => m.body)).toEqual(["also handle the follow-up"]);
    expect(messages.pendingFor(ctx, `task:${created.id}`)).toHaveLength(0);
  } finally { cleanup(); }
});

test("in-place admission refuses another task in a nested path of the same repository, both ways", async () => {
  const { ctx, repo, cleanup } = fixture(
    runners("codex", "headless"),
    { codex: CODEX });
  try {
    const cfg = loadStrategy(ctx).providers.codex as ProviderCfg;
    const nested = join(repo, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const occupy = (path: string) => {
      const other = createTask(ctx, { brief: { goal: `other ${path}`, repo: path }, kind: null,
        requestedExecutor: "codex", timeoutS: 30 });
      return updateTask(ctx, other.id, current => {
        current.state = "running";
        current.runnerPid = process.pid;
        current.placement = { requested: "current", mode: "current", why: "fixture" };
      });
    };
    // Another task works in a subdirectory while this one asks for the repository root.
    const sub = occupy(nested);
    await expect(runOwnedDirectCurrent(ctx, cfg, selected(ctx, repo, "codex")))
      .rejects.toMatchObject({ code: "capability_denied" });
    updateTask(ctx, sub.id, current => { current.state = "done"; delete current.runnerPid; });
    // Another task works at the root while this one asks for a subdirectory.
    occupy(repo);
    const inner = selected(ctx, nested, "codex");
    await expect(runOwnedDirectCurrent(ctx, cfg, inner)).rejects.toMatchObject({ code: "capability_denied" });
    expect(readTask(ctx, inner.id)?.run).toBeUndefined();
  } finally { cleanup(); }
});

test("remote start, poll and output refuse a call that holds no grant for that task's run", async () => {
  const ctx = fakeCtx();
  const unbound = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 10_000, grants: ["hosts"] });
  const foreign = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
    remoteObserve: { taskId: "t-other", attempt: 1, providerId: "pacer-exec-direct", dir: "/x", startedAt: 1 } },
  { deadlineMs: Date.now() + 10_000, grants: ["hosts"] });
  const request = { taskId: "t-victim", attempt: 1 };
  try {
    for (const authority of [unbound, foreign]) {
      await expect(answerOwnedRemoteStart(authority, request)).rejects.toMatchObject({ code: "capability_denied" });
      await expect(answerOwnedRemotePoll(authority, request)).rejects.toMatchObject({ code: "capability_denied" });
      expect(() => answerOwnedRemoteOutput(authority, request)).toThrow("not issued for this call");
    }
    // A resumed call may observe its own run but never START it.
    const resumed = createCallAuthority(ctx, { reads: [], commands: [], stores: [],
      remoteObserve: { taskId: "t-victim", attempt: 1, providerId: "pacer-exec-direct", dir: "/x", startedAt: 1 } },
    { deadlineMs: Date.now() + 10_000, grants: ["hosts"] });
    await expect(answerOwnedRemoteStart(resumed, request)).rejects.toThrow("no verified placement");
    expect(resumed.remoteObservedRun("t-victim", 1)).toEqual({ dir: "/x", startedAt: 1 });
    await resumed.revoke();
  } finally { await unbound.revoke(); await foreign.revoke(); }
});

test("new placement keeps the agent environment construction of the built-in path", async () => {
  const { ctx, repo, cleanup } = fixture(
    runners("codex", "headless"),
    { codex: "#!/bin/sh\nprintf '%s %s %s\\n' \"$PACER_ROLE\" \"$PACER_TASK_ID\" \"${CODEX_HOME:-unset}\"\n" });
  try {
    const task = updateTask(ctx, selected(ctx, repo, "codex").id, current => {
      current.placement = { requested: "new" };
      current.brief.worktreeBase = "head";
    });
    const out = await runOwnedDirectNew({ ...ctx, env: { ...ctx.env, CODEX_HOME: "/service/codex" } },
      loadStrategy(ctx).providers.codex as ProviderCfg, task);
    expect(out.report).toContain(`executor ${task.id} unset`);
  } finally { cleanup(); }
});
