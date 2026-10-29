import { expect, test } from "bun:test";
import { supervise } from "../src/supervisor/supervise";
import type { RunState } from "../src/supervisor/run";
import { tmpDir } from "./helpers";
import { agentHook, readReport, writeReport } from "../src/session/reports";
import { writeFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { folderKeys } from "../src/exec/claude-trust";
import { join } from "node:path";
import { localRunIO, startRun, stopRun } from "../src/supervisor/run";
import { fakeCtx } from "./helpers";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { progressPoller } from "../src/exec/direct";
import { taskData } from "../src/link/pump";
import { slotUse } from "../src/engine/slots";
import { eligibleForRetention } from "../src/tasks/retention";
import { runAttempt } from "../src/exec/direct";
import { gitRepo, realRun } from "./helpers";
import { validateStrategy } from "../src/config/strategy";
import { parseEnvelope } from "../src/link/envelope";
import { taskStatus } from "../src/view-model/words";

// A completed turn/report must never terminate a persistent conversation.
for (const status of ["done", "failed", "turn-ended"] as const) {
  test(`conversation ${status} stays alive until explicit stop despite deadline and idle`, async () => {
    let polls = 0, stops = 0;
    const state: RunState = {pid: 123, startedAt: 1, alive: true, exit: null,
      stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true,
      report: {status, summary: "Turn result", at: 2}};
    const result = await supervise({
      interactionMode: "conversation", deadlineMs: 0, now: () => 86400_000,
      io: {read: async () => {polls++; return state;}, stop: async () => {stops++; return {code: 143, killed: false};}},
      isStopped: () => polls >= 3, onPoll: async () => "idle", sleep: async () => {},
    });
    expect(result).toEqual({kind: "stopped", code: 143});
    expect(polls).toBe(3);
    expect(stops).toBe(1);
  });
}

for (const code of [0, 4]) {
  test(`conversation preserves agent exit code ${code}`, async () => {
    const result = await supervise({interactionMode: "conversation", deadlineMs: 0,
      io: {read: async () => ({pid: 123, startedAt: 1, alive: false, exit: code,
        stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null, interactive: true}),
        stop: async () => {throw Error("already exited");}}, isStopped: () => false});
    expect(result).toEqual({kind: "exited", code});
  });
}

test("conversation report does not prevent the next turn's activity hooks", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "interactive.json"), JSON.stringify({interactionMode: "conversation"}));
  writeReport(dir, "done", "First answer");
  agentHook(dir, {hook_event_name: "UserPromptSubmit"});
  expect(readReport(dir)?.status).toBe("running");
  agentHook(dir, {hook_event_name: "Stop"});
  expect(readReport(dir)?.status).toBe("turn-ended");
  agentHook(dir, {hook_event_name: "PermissionRequest"});
  expect(readReport(dir)?.status).toBe("needs-input");
});

test("agent hooks persist the native conversation identity for explicit resume", () => {
  const dir = tmpDir();
  agentHook(dir, {hook_event_name: "Stop", session_id: "native-session-123"});
  expect(require("node:fs").readFileSync(join(dir, "agent-session-id"), "utf8")).toBe("native-session-123");
});

test("detached conversation host survives reports after its supervisor disconnects", async () => {
  const dir = tmpDir();
  const started = startRun({dir, argv: ["sleep", "30"], cwd: dir, env: {PATH: process.env.PATH},
    session: "interactive", interactionMode: "conversation"});
  expect(started).toHaveProperty("pid");
  try {
    for (let i = 0; i < 100 && !(await localRunIO(dir).read()).startedAt; i++) await Bun.sleep(25);
    writeReport(dir, "done", "First turn is finished");
    await Bun.sleep(300);
    const state = await localRunIO(dir).read();
    expect(state.alive).toBe(true);
    expect(state.exit).toBeNull();
  } finally { await stopRun(dir, {graceMs: 500}); }
});

test("idle conversation stays active, occupies a slot and publishes turn activity", async () => {
  const ctx = fakeCtx();
  const task = createTask(ctx, {brief: {goal: "Talk", repo: ctx.home}, kind: null, requestedExecutor: "codex", timeoutS: 30});
  const run = {dir: ctx.home, attempt: 1, executor: "codex", startedAt: 1, mode: "current" as const,
    workdir: ctx.home, logFile: join(ctx.home, "unused"), interactionMode: "conversation" as const};
  updateTask(ctx, task.id, t => {t.state = "running"; t.interactionMode = "conversation"; t.run = run;});
  const poll = progressPoller(ctx, readTask(ctx, task.id)!, run);
  expect(await poll({pid: null, startedAt: 1, alive: true, exit: null, stdoutBytes: 0, stderrBytes: 0,
    lastOutputAt: null, interactive: true, report: {status: "turn-ended", summary: "Answer", at: 2}})).toBe("continue");
  const current = readTask(ctx, task.id)!;
  expect(current.state).toBe("running");
  expect(current.conversation?.activity).toBe("idle");
  expect(taskData(current)).toMatchObject({interactionMode: "conversation", conversation: {activity: "idle"}});
  expect(parseEnvelope({type: "task", data: taskData(current)})).toMatchObject({data: {interactionMode: "conversation", conversation: {activity: "idle"}}});
  expect(taskStatus(taskData(current)).label).toBe("Ready for input");
  expect(slotUse([current])).toMatchObject({byExecutor: {codex: 1}, local: 1});
  expect(eligibleForRetention({...ctx, now: ctx.now + 30 * 86400}, {...current, dismissed: true}, 14)).toBe(false);
});

test("conversation launches interactive per task with original request rather than executor contract", async () => {
  const repo = gitRepo(), bin = tmpDir();
  const executable = join(bin, "codex");
  writeFileSync(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.164.0"; exit; fi\nif [ "$1" = "--help" ] || [ "$2" = "--help" ]; then echo "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon"; exit; fi\nprintf "%s\\n" "$@"\n');
  chmodSync(executable, 0o700);
  const ctx = fakeCtx({run: realRun, env: {PATH: `${bin}:${process.env.PATH}`}});
  const task = createTask(ctx, {brief: {goal: "Explain this code", repo}, kind: null, requestedExecutor: "codex", timeoutS: 1});
  updateTask(ctx, task.id, t => {t.interactionMode = "conversation"; t.state = "running"; t.placement = {requested: "current"};});
  const strategy = validateStrategy({planner: "claude-code", providers: {codex: {}}}, ctx.home);
  const result = await runAttempt(ctx, strategy.providers.codex, readTask(ctx, task.id)!);
  expect(result.exec).toMatchObject({code: 0});
  expect(result.exec.stdout).toContain("Explain this code");
  expect(result.exec.stdout).not.toContain("--force");
  expect(result.exec.stdout).not.toContain("Executor contract");
  expect(readTask(ctx, task.id)?.run?.interactionMode).toBe("conversation");
});

test("an isolated conversation refuses git failure instead of running in the original checkout", async () => {
  const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"Work",repo:ctx.home},kind:null,requestedExecutor:"cursor",timeoutS:30});
  updateTask(ctx,task.id,t=>{t.state="running";t.interactionMode="conversation";t.placement={requested:"new"};});
  const strategy=validateStrategy({planner:"claude-code",providers:{cursor:{}}},ctx.home);
  const result=await runAttempt(ctx,strategy.providers.cursor,readTask(ctx,task.id)!);
  expect(result.exec.stderr).toContain("Cannot create an isolated conversation");
  expect(readTask(ctx,task.id)?.run).toBeUndefined();
});

for (const agent of ["claude-code", "opencode"]) {
  for (const resumed of [false, true]) {
    test(`${agent} ${resumed ? "resumes" : "creates"} its persistent native identity`, async () => {
      const repo = gitRepo(), bin = tmpDir();
      const executable = join(bin, agent === "claude-code" ? "claude" : "opencode");
      writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.281"; exit; fi
if [ "$1" = "--help" ] || [ "$2" = "--help" ]; then echo "--session-id --resume --add-dir --model --settings --standalone --session --prompt"; exit; fi
if [ "$1" = "api" ]; then echo '{"data":{"id":"ses_native"}}'; exit; fi
printf '%s\\n' "$@"
`);
      chmodSync(executable, 0o700);
      const ctx = fakeCtx({run: realRun, env: {PATH: `${bin}:${process.env.PATH}`}});
      const task = createTask(ctx, {brief: {goal: "Explain this code", repo}, kind: null, requestedExecutor: agent, timeoutS: 1, interactionMode: "conversation"});
      const oldId = agent === "claude-code" ? "01a15fa2-5a28-7bb0-9b62-6a4434975b55" : "ses_native";
      updateTask(ctx, task.id, t => {t.state = "running"; t.placement = {requested: "current"}; if (resumed) t.conversation = {activity: "starting", agentSessionId: oldId};});
      const strategy = validateStrategy({planner: "claude-code", providers: {[agent]: agent === "opencode" ? {via: "opencode", model: "provider/model", usage: "unmetered"} : {}}}, ctx.home);
      const result = await runAttempt(ctx, (strategy.providers[agent] ?? strategy.providers["opencode#opencode"]), readTask(ctx, task.id)!);
      expect(result.exec.stderr).toBe("");
      expect(result.exec.code).toBe(0);
      const current = readTask(ctx, task.id)!;
      expect(current.run?.agentSession?.id).toBeTruthy();
      expect(current.conversation?.agentSessionId).toBe(current.run?.agentSession?.id);
      expect(result.exec.stdout).toContain(current.run!.agentSession!.id);
      if (resumed) {
        expect(current.run?.agentSession?.id).toBe(oldId);
        expect(result.exec.stdout).not.toContain("Explain this code");
      } else expect(result.exec.stdout).toContain("Explain this code");
      expect(result.exec.stdout).not.toContain("--dangerously-skip-permissions");
      expect(result.exec.stdout).not.toContain("--auto");
    });
  }
}

// A delegated interactive lane runs unattended, like a task: Claude's folder-trust prompt would hold it before it
// reads its request. A chat (session.create) is attended, so the user answers the prompt there.
for (const interactive of [true, false]) {
  test(`a Claude ${interactive ? "interactive lane" : "chat"} in a new worktree on an account with its own home is ${interactive ? "" : "not "}pre-trusted and pre-approved for MCP`, async () => {
    const repo = gitRepo(), bin = tmpDir();
    const executable = join(bin, "claude");
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.281"; exit; fi
if [ "$1" = "--help" ] || [ "$2" = "--help" ]; then echo "--session-id --resume --add-dir --model --settings"; exit; fi
printf '%s\\n' "$@"
`);
    chmodSync(executable, 0o700);
    const ctx = fakeCtx({run: realRun, env: {PATH: `${bin}:${process.env.PATH}`}});
    const home = join(ctx.home, ".claude-team");
    mkdirSync(home, {recursive: true});
    writeFileSync(join(home, ".claude.json"), JSON.stringify({oauthAccount: {}}), {mode: 0o600});
    mkdirSync(ctx.pacerHome, {recursive: true});
    writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({planner: "claude-code",
      accounts: {main: {kind: "claude"}, team: {kind: "claude", home}}, routing: [{default: ["claude-code#team"]}]}));
    const task = createTask(ctx, {brief: {goal: "Explain this code", repo, worktreeBase: "head"}, kind: null, requestedExecutor: "claude-code#team", timeoutS: 1, interactionMode: "conversation"});
    updateTask(ctx, task.id, t => {t.state = "running"; t.placement = {requested: "new"}; if (interactive) t.interactive = true;});
    const strategy = validateStrategy({planner: "claude-code", accounts: {main: {kind: "claude"}, team: {kind: "claude", home}}, routing: [{default: ["claude-code#team"]}]}, ctx.home);
    const result = await runAttempt(ctx, strategy.providers["claude-code#team"], readTask(ctx, task.id)!);
    expect(result.exec.code).toBe(0);
    const workdir = readTask(ctx, task.id)!.run!.workdir;
    const projects = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).projects ?? {};
    for (const key of folderKeys(workdir)) expect(projects[key]?.hasTrustDialogAccepted).toBe(interactive ? true : undefined);
    expect(existsSync(join(ctx.home, ".claude.json"))).toBe(false);
    // Likewise Claude's project MCP prompt: a lane carries the source checkout's answers, a chat keeps the prompt.
    const settings = JSON.parse(readFileSync(join(readTask(ctx, task.id)!.run!.dir, "claude-settings.json"), "utf8"));
    expect(settings.enableAllProjectMcpServers).toBe(interactive ? true : undefined);
  });
}
