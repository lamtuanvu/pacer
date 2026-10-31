import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateStrategy } from "../src/config/strategy";
import * as launch from "../src/exec/launch";
import { computeStatus } from "../src/engine/status";
import { makeOrcaBackend } from "../src/plugins/executor-orca";
import { inProcessOrca } from "./fixtures/orca/in-process";
import { DEFAULT_EXECUTION } from "../src/config/execution";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { fakeRun, ok, raw } from "./fixtures/orca/fake";

function setup() {
  const ctx = fakeCtx();
  ctx.env.ORCA_USER_DATA_PATH = join(ctx.home, "orca data");
  const home = join(ctx.home, "team's $(unsafe) home");
  const s = validateStrategy({
    planner: "claude-code",
    accounts: {
      main: {kind: "claude"}, team: {kind: "claude", home},
      codex: {kind: "codex"}, work: {kind: "codex", home},
      managed: {kind: "codex", orca_account: "cx-team"},
      local: {kind: "endpoint", usage: "unmetered", model: "local/model"},
    },
    routing: [{default: ["claude-code#team", "codex", "codex#work", "codex#managed", "opencode#local"]}],
  }, "/strategy");
  mkdirSync(ctx.pacerHome, {recursive: true});
  // The public runnerEnv interface resolves account settings from the active strategy.
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({
    planner: "claude-code", accounts: Object.fromEntries(Object.entries(s.accounts).map(([name, a]) => [name, {
      kind: a.kind, ...(a.home ? {home: a.home} : {}), ...(a.orcaAccount ? {orca_account: a.orcaAccount} : {}), usage: a.usage,
      ...(a.model ? {model: a.model} : {}),
    }])), routing: [{default: Object.keys(s.runners)}], execution: {launch_mode: "headless"},
  }));
  return {ctx, s, home};
}

test("runnerEnv sets only non-default Claude and Codex account homes", async () => {
  const {ctx, s, home} = setup();
  expect(await launch.runnerEnv(ctx, s.runners["claude-code#team"])).toEqual({CLAUDE_CONFIG_DIR: home});
  expect(await launch.runnerEnv(ctx, s.runners["codex#work"])).toEqual({CODEX_HOME: home});
  expect(await launch.runnerEnv(ctx, s.runners["claude-code"])).toEqual({});
  expect(await launch.runnerEnv(ctx, s.runners.codex)).toEqual({});
  expect(await launch.runnerEnv(ctx, s.runners["opencode#local"])).toEqual({OPENCODE_CONFIG_CONTENT: JSON.stringify({default_agent:"build",model:s.runners["opencode#local"].model})});
});

test("Orca account home is resolved only when its folder exists", async () => {
  const {ctx, s} = setup();
  await expect(launch.runnerEnv(ctx, s.runners["codex#managed"])).rejects.toThrow("account folder not found");
  const home = join(ctx.env.ORCA_USER_DATA_PATH!, "codex-accounts", "cx-team", "home");
  mkdirSync(home, {recursive: true});
  expect(await launch.runnerEnv(ctx, s.runners["codex#managed"])).toEqual({CODEX_HOME: home});
});

test("missing Orca folder keeps usage visible but excludes the runner from routing", async () => {
  const {ctx, s} = setup();
  const readings = new Map(Object.keys(s.accounts).map(name => [name, {windows: [], capturedAt: null, stale: false}]));
  const status = await computeStatus(ctx, s, {profile: null, readings});
  expect(status.accounts.find(a => a.name === "managed")).toBeDefined();
  expect(status.executors.ranked.some(r => r.id === "codex#managed")).toBe(false);
  expect(status.executors.excluded).toContainEqual(expect.objectContaining({id: "codex#managed", account: "managed", reason: "account folder not found"}));
});

test.each([
  ["claude-code", "current", "claude"],
  ["codex", "current", "codex"],
  ["claude-code", "new-child", "claude"],
  ["codex", "new-child", "codex"],
  ["claude-code#team", "current", "claude"],
  ["codex#work", "current", "codex"],
] as const)("Orca %s on %s keeps agent supervision", async (id, worktree, agent) => {
  const {ctx, s} = setup();
  const f = fakeRun([
    [["git", "-C", "/work/app", "rev-parse", "--verify"], raw("a".repeat(40))],
    [["git", "-C", "/work/app", "fetch"], raw("")],
    [["git", "-C", "/work/app", "ls-remote"], raw("ref: refs/heads/main\tHEAD\n")],
    [["git", "-C", "/work/app", "rev-parse"], raw("/work/app\nmain\n")],
    [["git", "-C", "/work/app", "status"], raw("")],
    [["orca", "status"], ok("status-ready.json")],
    [["orca", "repo", "list"], raw('{"ok":true,"result":{"repos":[{"id":"repo1","path":"/work/app"}]}}')],
    [["orca", "worktree", "show"], raw('{"ok":true,"result":{"worktree":{"id":"repo1::/work/app","path":"/work/app"}}}')],
    [["orca", "worktree", "create"], (a: string[]) => raw(JSON.stringify({ok: true, result: {worktree: {id: `repo1::/work/${a[a.indexOf("--name") + 1]}`}}}))],
    [["orca", "terminal", "create"], (a: string[]) => a.includes("--command") ? raw('{"ok":true,"result":{"terminal":{"handle":"term_agent"}}}') : ok("coordinator-terminal.json")],
    [["orca", "terminal", "wait"], raw('{"ok":true,"result":{"wait":{"satisfied":true}}}')],
    [["orca", "terminal", "show"], ok("terminal-show-live.json")],
    [["orca", "orchestration", "run-create"], ok("run-create.json")],
    [["orca", "orchestration", "worker-start"], ok("worker-start-t1-auto.json")],
    [["orca", "orchestration", "check"], [ok("check-1.ndjson"), ok("ack-1.json")]],
    [["orca", "orchestration", "worker-release"], ok("worker-release-t1.json")],
    [["orca", "terminal", "close"], ok("terminal-close.json")],
  ]);
  ctx.run = f.run;
  const task = createTask(ctx, {brief: {goal: "test", repo: "/work/app"}, kind: null, requestedExecutor: null, timeoutS: 10});
  const backend = makeOrcaBackend({loadExecution: () => ({...DEFAULT_EXECUTION, worktree}), sleep: async () => {}}, inProcessOrca({sleep: async () => {}}));
  const out = await backend.runAttempt(ctx, s.providers[id], task);
  expect(out.backend).toBe("orca");
  expect(f.calls.some(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"))).toBe(true);
  const command = f.calls.find(a => a[1] === "terminal" && a[2] === "create" && a.includes("--command"))!;
  const text = command[command.indexOf("--command") + 1];
  if (id.includes("#")) {
    expect(text).toContain(`'${agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}=`);
    expect(text).toContain("'\\''s $(unsafe) home'");
    expect(text).not.toContain("PACER_KEY_");
    const logged = readFileSync(out.attempt.log, "utf8");
    const key = agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    expect(logged).toContain(`'${key}=<${key}>'`);
    expect(logged).not.toContain("$(unsafe)");
  }
  expect(text.includes("CLAUDE_CODE_SANDBOXED=1")).toBe(agent === "claude");
  // A default account unsets the home variable Orca's shell may carry; a selected account sets it.
  expect(text.startsWith(`exec env -u ${agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"} `)).toBe(!id.includes("#"));
  const start = f.calls.find(a => a[2] === "worker-start")!;
  expect(start[start.indexOf("--terminal") + 1]).toBe("term_agent");
  expect(start).not.toContain("--agent");
  if (worktree === "new-child") {
    expect(start[start.indexOf("--worktree") + 1]).toBe(`id:repo1::/work/pacer-${task.id}-${id}`);
    expect(out.worktree).toBe(`/work/pacer-${task.id}-${id}`);
  } else {
    expect(start[start.indexOf("--worktree") + 1]).toBe("id:repo1::/work/app");
    expect(out.worktree).toBe("/work/app");
  }

});

test("direct launch passes the account env and clears an inherited planner account", async () => {
  const {runAttempt} = await import("../src/exec/direct");
  const {chmodSync} = await import("node:fs");
  const {ctx, s, home} = setup();
  const bin = join(ctx.home, "bin");
  mkdirSync(bin);
  const claude = join(bin, "claude");
  writeFileSync(claude, '#!/bin/sh\nprintf "%s|%s|%s" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$PACER_ROLE"\n');
  chmodSync(claude, 0o755);
  ctx.env = {...ctx.env, PATH: bin, CLAUDE_CONFIG_DIR: "planner-home", CODEX_HOME: "planner-codex"};
  const task = createTask(ctx, {brief: {goal: "test", repo: ctx.home}, kind: null, requestedExecutor: null, timeoutS: 10});
  const selected = await runAttempt(ctx, s.providers["claude-code#team"], task);
  expect(selected.exec.code).toBe(0);
  expect(selected.exec.stdout).toBe(`${home}||executor`);
  const defaultAccount = await runAttempt(ctx, s.providers["claude-code"], task);
  expect(defaultAccount.exec.code).toBe(0);
  expect(defaultAccount.exec.stdout).toBe("||executor");
});

test("pacer-managed home expands the user's home before launch", async () => {
  const {ctx, s} = setup();
  const file = join(ctx.pacerHome, "strategy.yaml");
  const rawStrategy = JSON.parse(readFileSync(file, "utf8"));
  rawStrategy.accounts.team.home = "~/.claude-team";
  writeFileSync(file, JSON.stringify(rawStrategy));
  expect(await launch.runnerEnv(ctx, s.runners["claude-code#team"])).toEqual({CLAUDE_CONFIG_DIR: join(ctx.home, ".claude-team")});
});
