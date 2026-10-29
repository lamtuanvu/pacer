import { eligibility } from "./fixtures/eligibility";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardEventId } from "../src/classify/state";
import { readLabels } from "../src/tasks/labels";
import { defaultHooks, type GuardOpinion } from "../src/classify/hooks";
import type { Status } from "../src/engine/status";
import { decideGuard, decideShellGuard, detectShellExecutorLaunch, parseGuardInput, renderGuard, runGuard } from "../src/guard/guard";
import { fakeCtx } from "./helpers";
import { tmpDir } from "./helpers";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork } from "../src/dispatch/work";
import { issueEnforcementToken } from "../src/dispatch/enforcement-token";

function status(overrides: Partial<Status> = {}): Status {
  return {
    generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
    disabled: false, paused: null, modeHold: null, calendarPace: true,
    providers: ["claude-code", "codex", "local"].map((id) => ({
      id, usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false,
    })),
    executors: { ranked: [{ id: "codex", score: 1, verdict: "OK", reason: "ok", eligibility: eligibility() }], excluded: [] },
    ...overrides,
  };
}

const input = { subagentType: "general-purpose", prompt: "Implement the change" };
const stdin = JSON.stringify({ tool_name: "Agent", tool_input: { prompt: input.prompt } });
const deps = { status: async () => status() };
const reason = "pacer: 'general-purpose' is a Claude subagent, so it spends Claude's own quota (mode: normal). Delegate execution work with `pacer delegate --brief-file - --json` (top executor now: codex) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.";
const feedbackHint = (value: typeof input & { model?: string }) => {
  const id = guardEventId(value);
  return ` (pacer event ${id}: if this block was wrong, ask the user to start the session with PACER=off; with the pacer MCP tools connected, call guard_feedback with event_id "${id}" and correct=false)`;
};
const deny = (message: string) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message,
} });

test("blocks execution with planner quota, top executor and a self-contained brief reason", async () => {
  const ctx = fakeCtx();
  const decision = await decideGuard(ctx, input, deps);
  expect(decision.allow).toBe(false);
  expect(decision.reason).toBe(reason + feedbackHint(input));
  expect(JSON.parse(renderGuard("claude-code", decision))).toEqual(deny(reason + feedbackHint(input)));
  for (const mode of ["strict", "emergency"] as const) {
    expect((await decideGuard(ctx, input, { status: async () => status({ mode }) })).allow).toBe(false);
  }
});

test("allows helpers, reviewer globs, pacer agents and configured provider executors case-insensitively", async () => {
  const ctx = fakeCtx();
  for (const subagentType of ["EXPLORE", "plan", "CLAUDE-CODE-GUIDE", "StatusLine-Setup",
    "security-REVIEWER", "code-analyzer-extra", "PR-REVIEW-TOOLKIT:code", "PACER-worker", "Pacer:worker"]) {
    // Static helpers must work even before status can be loaded.
    expect((await decideGuard(ctx, { ...input, subagentType }, {
      status: async () => { throw new Error("must not need status"); },
    })).allow).toBe(true);
  }
  for (const subagentType of ["CODEX-executor", "local-executor", "claude-code-executor"]) {
    expect((await decideGuard(ctx, { ...input, subagentType }, deps)).allow).toBe(true);
  }
  for (const subagentType of ["unknown-executor", "Explore-implementer", "xpr-review-toolkit:code", "pacer"])
    expect((await decideGuard(ctx, { ...input, subagentType }, deps)).allow).toBe(false);
});

test("lifts the guard for PACER=off, relaxed mode or no ranked executor", async () => {
  expect((await decideGuard(fakeCtx({ env: { PACER: "OFF" } }), input, {
    hooks: { ...defaultHooks, guard: async () => { throw new Error("must not classify"); } },
    status: async () => { throw new Error("must not load status"); },
  })).allow).toBe(true);
  for (const st of [status({ mode: "relaxed" }), status({ executors: { ranked: [], excluded: [] } })]) {
    expect((await decideGuard(fakeCtx(), input, { status: async () => st })).allow).toBe(true);
  }
});

test("classifier precedes all allow-lists, respects lifts and falls back on null or rejection", async () => {
  const ctx = fakeCtx();
  const hooks = (opinion: GuardOpinion | null) => ({ ...defaultHooks, guard: async () => opinion });
  const allow = await decideGuard(ctx, input, {
    hooks: hooks({ allow: true, adapter: "test", confidence: 1 }),
    status: async () => { throw new Error("must not load status"); },
  });
  expect(allow.allow).toBe(true);
  expect(allow.source).toBe("classifier");
  const no = hooks({ allow: false, reason: "execution detected", adapter: "test", confidence: 1 });
  for (const subagentType of ["Explore", "pacer:worker", "codex-executor", "general-purpose"]) {
    const decision = await decideGuard(ctx, { ...input, subagentType }, { ...deps, hooks: no });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain(" (execution detected)");
    expect(decision.reason).toEndWith(feedbackHint({ ...input, subagentType }));
  }
  for (const st of [status({ mode: "relaxed" }), status({ executors: { ranked: [], excluded: [] } })])
    expect((await decideGuard(ctx, input, { status: async () => st, hooks: no })).allow).toBe(true);
  for (const fallback of [hooks(null), { ...defaultHooks, guard: async () => { throw new Error("offline"); } }]) {
    expect((await decideGuard(ctx, { ...input, subagentType: "Plan" }, { ...deps, hooks: fallback })).allow).toBe(true);
    expect((await decideGuard(ctx, input, { ...deps, hooks: fallback })).allow).toBe(false);
  }
});

test("codex parses spawn_agent and Agent and renders PreToolUse denial or empty allow", async () => {
  const ctx = fakeCtx();
  for (const tool_name of ["spawn_agent", "Agent"]) {
    const raw = { tool_name, tool_input: { agent_type: "default", message: "Implement it" } };
    expect(parseGuardInput("codex", raw)).toEqual({ subagentType: "default", prompt: "Implement it" });
    const result = JSON.parse(await runGuard(ctx, "codex", JSON.stringify(raw), deps));
    expect(result).toEqual(deny(reason.replace("'general-purpose'", "'default'") + feedbackHint({ subagentType: "default", prompt: "Implement it" })));
  }
  expect(parseGuardInput("codex", { tool_name: "spawn_agent", tool_input: {} })).toEqual({ subagentType: "default", prompt: "" });
  expect(parseGuardInput("claude-code", { tool_name: "Task", tool_input: { subagent_type: "Plan", prompt: "Design" } }))
    .toEqual({ subagentType: "Plan", prompt: "Design" });
  expect(await runGuard(ctx, "codex", JSON.stringify({ tool_name: "spawn_agent", tool_input: { agent_type: "Plan" } }), deps)).toBe("");
});

test("cursor parses its flat input and renders permission plus denial user_message", async () => {
  const ctx = fakeCtx();
  const raw = { subagent_type: "generalPurpose", task: "Implement it", subagent_model: "auto" };
  expect(parseGuardInput("cursor", raw)).toEqual({ subagentType: "generalPurpose", prompt: "Implement it", model: "auto" });
  expect(parseGuardInput("cursor", {})).toEqual({ subagentType: "generalPurpose", prompt: "" });
  expect(JSON.parse(await runGuard(ctx, "cursor", JSON.stringify(raw), deps)))
    .toEqual({ permission: "deny", user_message: reason.replace("'general-purpose'", "'generalPurpose'") + feedbackHint({ subagentType: "generalPurpose", prompt: "Implement it", model: "auto" }) });
  expect(JSON.parse(await runGuard(ctx, "cursor", '{"subagent_type":"Explore"}', deps))).toEqual({ permission: "allow" });
});

test("fails open for junk, non-subagent tools, unknown planners, missing strategy, throws and slow status", async () => {
  const ctx = fakeCtx();
  for (const planner of ["claude-code", "codex", "cursor"]) {
    const allowed = planner === "cursor" ? '{"permission":"allow"}' : "";
    for (const junk of ["", "bad json", "null", "[]", "42"])
      expect(await runGuard(ctx, planner, junk, deps)).toBe(allowed);
    const valid = planner === "cursor" ? '{"task":"Implement it"}' : JSON.stringify({
      tool_name: planner === "codex" ? "spawn_agent" : "Agent", tool_input: {},
    });
    expect(await runGuard(ctx, planner, valid)).toBe(allowed); // temp home has no strategy
    expect(await runGuard(ctx, planner, valid, { status: async () => { throw new Error("broken status"); } })).toBe(allowed);
    expect(await runGuard(ctx, planner, valid, { status: () => new Promise<Status>(() => {}), timeoutMs: 20 })).toBe(allowed);
  }
  for (const planner of ["claude-code", "codex"])
    expect(await runGuard(ctx, planner, '{"tool_name":"Read","tool_input":{}}', deps)).toBe("");
  expect(await runGuard(ctx, "unknown", stdin, deps)).toBe("");
  expect(await runGuard(ctx, "opencode", stdin, deps)).toBe("");
});


test("records the final verdict and event id for rules, classifiers and lifted allows", async () => {
  const cases = [
    { value: input, hooks: defaultHooks, st: status(), blocked: true, source: "rules" },
    { value: { ...input, subagentType: "Plan" }, hooks: defaultHooks, st: status(), blocked: false, source: "rules" },
    { value: { ...input, subagentType: "codex-executor" }, hooks: defaultHooks, st: status(), blocked: false, source: "rules" },
    { value: input, hooks: { ...defaultHooks, guard: async () => ({ allow: true, adapter: "test", confidence: 1 }) }, st: status(), blocked: false, source: "classifier" },
    { value: input, hooks: { ...defaultHooks, guard: async () => ({ allow: false, adapter: "test", confidence: 1 }) }, st: status(), blocked: true, source: "classifier" },
    { value: input, hooks: { ...defaultHooks, guard: async () => ({ allow: false, adapter: "test", confidence: 1 }) }, st: status({ mode: "relaxed" }), blocked: false, source: "rules" },
    { value: input, hooks: defaultHooks, st: status({ executors: { ranked: [], excluded: [] } }), blocked: false, source: "rules" },
  ];
  for (const c of cases) {
    const ctx = fakeCtx();
    const decision = await decideGuard(ctx, c.value, { hooks: c.hooks, status: async () => c.st });
    expect(decision.allow).toBe(!c.blocked);
    expect(readLabels(ctx)).toEqual([{ ts: ctx.now, type: "guard_verdict", event_id: guardEventId(c.value), blocked: c.blocked, source: c.source }]);
    if (c.blocked) expect(decision.reason).toEndWith(feedbackHint(c.value));
  }
});

test("verdict logging failures preserve deny and allow decisions", async () => {
  const ctx = fakeCtx();
  writeFileSync(ctx.pacerHome, "not a directory");
  const denied = await decideGuard(ctx, input, { ...deps, hooks: defaultHooks });
  expect(denied.allow).toBe(false);
  expect(denied.reason).toBe(reason + feedbackHint(input));
  expect(await decideGuard(ctx, { ...input, subagentType: "Plan" }, { hooks: defaultHooks })).toEqual({ allow: true });
});

test("PACER off and executor-session exits do not record guard verdicts", async () => {
  for (const env of [{ PACER: "off" }, { PACER_ROLE: "executor" }]) {
    const ctx = fakeCtx({ env });
    expect((await decideGuard(ctx, input, deps)).allow).toBe(true);
    expect(readLabels(ctx)).toEqual([]);
  }
});

test("strict executor guards deny native child calls across hook formats",async()=>{
  const ctx=fakeCtx(),task=createTask(ctx,{brief:{goal:"work",repo:tmpDir()},kind:"feature",requestedExecutor:null,timeoutS:600});
  registerWork(ctx,task.id,{allowDelegation:false});updateTask(ctx,task.id,t=>{t.state="running";});
  const token=issueEnforcementToken(ctx,task.id,1);
  const strict={...ctx,env:{...ctx.env,PACER_ROLE:"executor",PACER:"off",PACER_ENFORCEMENT_MODE:"strict",PACER_ENFORCEMENT_TOKEN:token}};
  for(const tool_name of ["Agent","Task"]){
    const result=JSON.parse(await runGuard(strict,"claude-code",JSON.stringify({tool_name,tool_input:{subagent_type:"Explore"}})));
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("pacer dispatch child");
  }
  const codex=JSON.parse(await runGuard(strict,"codex",JSON.stringify({tool_name:"spawn_agent",tool_input:{agent_type:"Plan"}})));
  expect(codex.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(JSON.parse(await runGuard(strict,"cursor",JSON.stringify({subagent_type:"explore"})))).toMatchObject({permission:"deny"});
});

test("strict executor guards fail closed on missing identity and malformed hook input",async()=>{
  const marker=join(tmpDir(),"report-failed");
  const ctx=fakeCtx({env:{PACER_ROLE:"executor",PACER_ENFORCEMENT_MODE:"strict",PACER_GUARD_FAILURE_MARKER:marker}});
  for(const raw of ["bad json",JSON.stringify({tool_name:"Agent",tool_input:{}})]){
    const result=JSON.parse(await runGuard(ctx,"claude-code",raw));
    expect(result.hookSpecificOutput.permissionDecision).toBe("deny");
  }
  expect(readFileSync(marker,"utf8")).toBe("guard-report-failed");
});

function withManagedAccounts(ctx: ReturnType<typeof fakeCtx>): void {
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), [
    "accounts:",
    "  personal-claude: {kind: claude}",
    "  claude1: {kind: claude, home: ~/.claude-claude1}",
    "  personal-codex: {kind: codex}",
    "  codex1: {kind: codex, home: ~/.codex-codex1}",
    "planner: claude-code#claude1",
    "routing:",
    "  - default: [claude-code, codex]",
    "",
  ].join("\n"));
}

test("detectShellExecutorLaunch matches PACER_ROLE=executor on a known executor CLI, chained or path-qualified", () => {
  const ctx = fakeCtx();
  for (const cli of ["claude", "codex", "pi", "opencode"] as const) {
    expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor ${cli} --model sonnet "do work"`)).toEqual({ cli });
    expect(detectShellExecutorLaunch(ctx, `cd /repo && PACER_ROLE=executor ${cli} run`)).toEqual({ cli });
    expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor /usr/local/bin/${cli} run`)).toEqual({ cli });
    expect(detectShellExecutorLaunch(ctx, `${cli} --help`)).toBeNull();
  }
  expect(detectShellExecutorLaunch(ctx, "PACER_ROLE=executor npm test")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "PACER_ROLE=other claude --model sonnet")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "ls -la")).toBeNull();
});

test("detectShellExecutorLaunch matches a pacer-managed CLAUDE_CONFIG_DIR/CODEX_HOME but not the default folder", () => {
  const ctx = fakeCtx();
  withManagedAccounts(ctx);
  const claudeManaged = join(ctx.home, ".claude-claude1");
  const codexManaged = join(ctx.home, ".codex-codex1");
  expect(detectShellExecutorLaunch(ctx, `CLAUDE_CONFIG_DIR=${claudeManaged} claude --model sonnet --permission-mode bypassPermissions "brief"`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, "CLAUDE_CONFIG_DIR=$HOME/.claude-claude1 claude --model sonnet")).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `CODEX_HOME=${codexManaged} codex exec "do work"`)).toEqual({ cli: "codex" });
  expect(detectShellExecutorLaunch(ctx, `CLAUDE_CONFIG_DIR=${join(ctx.home, ".claude")} claude --model sonnet`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "claude --model sonnet")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `CLAUDE_CONFIG_DIR=${claudeManaged} pi run`)).toBeNull();
});

test("detectShellExecutorLaunch matches ;/|/newline chaining, env/exec prefixes, export earlier in the same command, and bash -c/sh -c", () => {
  const ctx = fakeCtx();
  expect(detectShellExecutorLaunch(ctx, 'cd /repo; PACER_ROLE=executor claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, 'cd /repo\nPACER_ROLE=executor claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, 'echo hi | PACER_ROLE=executor claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, 'env PACER_ROLE=executor claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, 'exec codex exec "<brief>" --dangerously-bypass-approvals-and-sandbox', )).toBeNull(); // no PACER_ROLE/managed home at all
  expect(detectShellExecutorLaunch(ctx, 'exec env PACER_ROLE=executor codex exec "<brief>"')).toEqual({ cli: "codex" });
  expect(detectShellExecutorLaunch(ctx, 'export PACER_ROLE=executor; claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, 'export PACER_ROLE=executor && claude --model sonnet "<brief>"')).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `bash -c 'PACER_ROLE=executor claude --model sonnet "<brief>"'`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `sh -c "PACER_ROLE=executor codex exec '<brief>'"`)).toEqual({ cli: "codex" });
  // An export that is not reached (never runs before `claude`, or applies to the wrong pipeline stage) must not match.
  expect(detectShellExecutorLaunch(ctx, 'claude --model sonnet "<brief>"; export PACER_ROLE=executor')).toBeNull();
  expect(detectShellExecutorLaunch(ctx, 'export PACER_ROLE=executor | claude --model sonnet "<brief>"')).toBeNull();
  // A bare (non-exported) assignment statement does not persist to a later command.
  expect(detectShellExecutorLaunch(ctx, 'PACER_ROLE=executor; claude --model sonnet "<brief>"')).toBeNull();
  // env/bash with other flags in front is a known, documented gap.
  expect(detectShellExecutorLaunch(ctx, 'env -u HOME PACER_ROLE=executor claude --model sonnet')).toBeNull();
});

test("detectShellExecutorLaunch carries inline and exported environment into bash/sh/zsh -c (PR #463 review)", () => {
  const ctx = fakeCtx();
  withManagedAccounts(ctx);
  expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor bash -c "claude --model sonnet '<brief>'"`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `export PACER_ROLE=executor; sh -c "claude --model sonnet '<brief>'"`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `env PACER_ROLE=executor zsh -c 'codex exec "<brief>"'`)).toEqual({ cli: "codex" });
  expect(detectShellExecutorLaunch(ctx, `CLAUDE_CONFIG_DIR=$HOME/.claude-claude1 bash -c 'claude --model sonnet'`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `export CODEX_HOME=~/.codex-codex1 && sh -c 'codex exec "<brief>"'`)).toEqual({ cli: "codex" });
  expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor bash -c "sh -c 'claude run'"`)).toEqual({ cli: "claude" });
  // An exported variable that is reassigned or exported by name keeps tracking the shell's own environment.
  expect(detectShellExecutorLaunch(ctx, "PACER_ROLE=executor; export PACER_ROLE; claude run")).toEqual({ cli: "claude" });
  // Benign wrappers stay allowed: no executor identity, a non-exported variable, or a default folder.
  expect(detectShellExecutorLaunch(ctx, `bash -c 'claude --help'`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=other bash -c 'claude --model sonnet'`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor; bash -c 'claude --model sonnet'`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `CLAUDE_CONFIG_DIR=$HOME/.claude bash -c 'claude --model sonnet'`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `PACER_ROLE=executor bash -c 'npm test'`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; PACER_ROLE=other; claude run")).toBeNull();
  // A plain, unconditional `unset` removes an exported variable for later commands.
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; unset PACER_ROLE; claude --help")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; unset -v PACER_ROLE; claude --help")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; unset -- PACER_ROLE; claude --help")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; unset -v -- PACER_ROLE; claude --help")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; unset PACER_ROLE && claude --help")).toBeNull();
  // Every other form fails closed and keeps the variable (#463 round-2 security review, A4).
  for (const unset of [
    "false && unset PACER_ROLE", "true || unset PACER_ROLE", "true && false || unset PACER_ROLE",
    "unset -f PACER_ROLE", "unset -fv PACER_ROLE", "unset -vf PACER_ROLE", "unset -n PACER_ROLE", "unset -v -f PACER_ROLE",
    "unset PACER_ROLE | cat", "unset PACER_ROLE &", "unset PACER_ROLE=x",
  ]) expect(detectShellExecutorLaunch(ctx, `export PACER_ROLE=executor; ${unset}; claude run`)).toEqual({ cli: "claude" });
  // Any `unset` after `&&` counts as conditional, even when the left side always succeeds.
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor && unset PACER_ROLE; claude run")).toEqual({ cli: "claude" });
});

test("detectShellExecutorLaunch splits control operators outside quotes only, and tells || from | (PR #463 review)", () => {
  const ctx = fakeCtx();
  expect(detectShellExecutorLaunch(ctx, `bash -c 'PACER_ROLE=executor claude --model sonnet | cat'`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, `sh -c "PACER_ROLE=executor claude run; echo done"`)).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor || true; claude run")).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor; echo start | claude run")).toEqual({ cli: "claude" });
  expect(detectShellExecutorLaunch(ctx, "PACER_ROLE=executor claude run 2>&1 | tee log")).toEqual({ cli: "claude" });
  // Quoted, commented or escaped text is inert: it never starts a CLI.
  expect(detectShellExecutorLaunch(ctx, "echo 'safe; PACER_ROLE=executor claude run'")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `echo "a | PACER_ROLE=executor claude run"`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, `grep -n "x && PACER_ROLE=executor codex exec" notes.md`)).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "ls # ; PACER_ROLE=executor claude run")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "echo safe\\; PACER_ROLE=executor claude run")).toBeNull();
  expect(detectShellExecutorLaunch(ctx, "'PACER_ROLE=executor' claude run")).toBeNull();
  // A background job's export runs in a subshell and does not reach the next command.
  expect(detectShellExecutorLaunch(ctx, "export PACER_ROLE=executor & claude run")).toBeNull();
});

test("decideShellGuard blocks a managed-home executor launch, with the same exemptions as the subagent guard", async () => {
  const command = `PACER_ROLE=executor CLAUDE_CONFIG_DIR=$HOME/.claude-claude1 claude --model sonnet --permission-mode bypassPermissions "<brief>"`;
  const { stateHash } = await import("../src/classify/state");
  const id = stateHash(JSON.stringify({ shell_cli: "claude", command }));
  const shellReason = `pacer: this shell command starts 'claude' as a pacer-managed executor, so it would spend Claude's own quota outside pacer's routing, review and budget (mode: normal). Delegate execution work with \`pacer delegate --brief-file - --json\` (top executor now: codex) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.`
    + ` (pacer event ${id}: if this block was wrong, ask the user to start the session with PACER=off; with the pacer MCP tools connected, call guard_feedback with event_id "${id}" and correct=false)`;
  const ctx = fakeCtx();
  const decision = await decideShellGuard(ctx, command, deps);
  expect(decision).toEqual({ allow: false, reason: shellReason });
  expect(readLabels(ctx)).toEqual([{ ts: ctx.now, type: "guard_verdict", event_id: id, blocked: true, source: "rules" }]);

  // Same exemptions as the subagent guard.
  expect((await decideShellGuard(fakeCtx({ env: { PACER: "off" } }), command, deps)).allow).toBe(true);
  expect((await decideShellGuard(fakeCtx({ env: { PACER_ROLE: "executor" } }), command, deps)).allow).toBe(true);
  expect((await decideShellGuard(ctx, command, { status: async () => status({ mode: "relaxed" }) })).allow).toBe(true);
  expect((await decideShellGuard(ctx, command, { status: async () => status({ executors: { ranked: [], excluded: [] } }) })).allow).toBe(true);
  // Not a recognized executor launch at all.
  expect((await decideShellGuard(ctx, "ls -la", deps)).allow).toBe(true);
});

test("runGuard routes claude-code Bash calls through the shell guard, exempt under strict executor mode", async () => {
  const ctx = fakeCtx();
  const denyCommand = "PACER_ROLE=executor claude --model sonnet --permission-mode bypassPermissions \"<brief>\"";
  const denied = JSON.parse(await runGuard(ctx, "claude-code", JSON.stringify({ tool_name: "Bash", tool_input: { command: denyCommand } }), deps));
  expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("this shell command starts 'claude'");
  expect(await runGuard(ctx, "claude-code", JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), deps)).toBe("");

  const strict = { ...ctx, env: { ...ctx.env, PACER_ROLE: "executor", PACER_ENFORCEMENT_MODE: "strict" } };
  expect(await runGuard(strict, "claude-code", JSON.stringify({ tool_name: "Bash", tool_input: { command: denyCommand } }), deps)).toBe("");
});
