import { expect, test } from "bun:test";
import { defaultHooks, type GuardOpinion } from "../src/classify/hooks";
import type { Status } from "../src/engine/status";
import { decideGuard, parseGuardInput, renderGuard, runGuard } from "../src/guard/guard";
import { fakeCtx } from "./helpers";

function status(overrides: Partial<Status> = {}): Status {
  return {
    generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
    disabled: false, calendarPace: true,
    providers: ["claude-code", "codex", "local"].map((id) => ({
      id, usage: "unmetered", windows: [], binding: null, verdict: "OK", installed: true, stale: false,
    })),
    executors: { ranked: [{ id: "codex", score: 1, verdict: "OK", reason: "ok" }], excluded: [] },
    ...overrides,
  };
}

const input = { subagentType: "general-purpose", prompt: "Implement the change" };
const stdin = JSON.stringify({ tool_name: "Agent", tool_input: { prompt: input.prompt } });
const deps = { status: async () => status() };
const reason = "pacer: 'general-purpose' is a Claude subagent, so it spends Claude's own quota (mode: normal). Delegate execution work with the pacer MCP tool `delegate` (top executor now: codex) and a self-contained brief: goal, absolute repo path, scope, acceptance command. If this needs planner-level judgement (design, review), do it in the main conversation, or ask the user to start the session with PACER=off.";
const deny = (message: string) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message,
} });

test("blocks execution with planner quota, top executor and a self-contained brief reason", async () => {
  const ctx = fakeCtx();
  const decision = await decideGuard(ctx, input, deps);
  expect(decision.allow).toBe(false);
  expect(decision.reason).toBe(reason);
  expect(JSON.parse(renderGuard("claude-code", decision))).toEqual(deny(reason));
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
    expect(decision.reason).toEndWith(" (execution detected)");
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
    expect(result).toEqual(deny(reason.replace("'general-purpose'", "'default'")));
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
    .toEqual({ permission: "deny", user_message: reason.replace("'general-purpose'", "'generalPurpose'") });
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
