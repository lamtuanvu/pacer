import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { parseClaudeRun, parseRun } from "../plugins/assistant-executor/index";
import { admit, ask, assistantGrantFor, cancel, candidates, deleteConversations, pruneConversationDirs, saveSettings, selfTest } from "../src/assistant/service";
import { judge } from "../src/assistant/selftest";
import {
  askConfig, askSystem, CLAUDE_ASK_DISALLOWED, CLAUDE_EMPTY_MCP, CLAUDE_EXPECT_VERSION_ENV,
  CLAUDE_PERMISSION_MODE, CLAUDE_SESSION_ID, claudeAskTurn, claudeResumeSession, claudeVersionSemver, seededPrompt, STDIN_CAP,
} from "../src/assistant/ask-mode";
import { getTurn, readBackendSession, readSettings, writeBackendSession, writeSettings } from "../src/assistant/store";
import type { AssistantScope } from "../src/assistant/types";
import type { Strategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
import { assistantReplyParams } from "../src/plugins/protocol";
import { bundledPluginSpawn, pluginRegistry } from "../src/plugins/index";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// The executor backend end to end: the real bundled assistant-executor plugin runs the host-issued
// ask-mode command through capability.process.spawn, against a fake `opencode` that records what it
// was given and answers in opencode's `--format json` event shape.

const scope: AssistantScope = { kind: "dispatch", days: 7 };
const strategy = () => ({
  planner: { agent: "claude-code", account: "claude" },
  accounts: { oc: { kind: "endpoint", source: "opencode", provider: "opencode-go", model: "opencode-go/glm-test" } },
  runners: {}, dispatch: { reservePct: 0 },
}) as unknown as Strategy;
const status = async () => ({ mode: "normal", planner: "claude-code", accounts: [] }) as unknown as Status;
const read = async (_c: Ctx, op: string) => op === "snapshot.get"
  ? { snapshot: { counts: { open: 3 }, attention: [], mode: "normal", pause: null, planner: "claude-code" } }
  : { mode: "normal", planner: "claude-code", paused: null, accounts: [] };

/** Fake `opencode`: version line, or ACP JSON-RPC via test/fixtures/opencode-acp.mjs. */
const FIXTURE = join(import.meta.dir, "fixtures", "opencode-acp.mjs");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-ask-")), bin = join(dir, "opencode");
  writeFileSync(bin, `#!${process.execPath}
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.2.3-fake"); process.exit(0); }
if (argv[0] !== "acp") { console.error("expected acp", argv); process.exit(2); }
process.env.FAKE_DIR = ${JSON.stringify(dir)};
process.env.FAKE_LOG = process.env.FAKE_LOG ?? ${JSON.stringify(join(dir, "calls.jsonl"))};
await import(${JSON.stringify(FIXTURE)});
`); chmodSync(bin, 0o755);
  const base = fakeCtx();
  const c = { ...base, env: { ...base.env, HOME: base.home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, which: (name: string) => name === "opencode" ? bin : base.which(name) } as typeof base;
  pluginRegistry(c, { bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
  writeSettings(c, { runner: null, account: "oc", backend: "executor", expect_rev: readSettings(c).rev });
  const deps = { strategy: () => strategy(), status, keys: async () => [], read, cards: { task: () => null } };
  const mode = (m: "deny" | "leak" | "silent" | "slow" | "leak-on-resume" | "no-tools") => writeFileSync(join(dir, "mode"), m);
  const calls = () => existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as {
        argv?: string[]; cwd?: string; stdin?: string; env?: Record<string, string>;
        method?: string; prompt?: string; sessionId?: string; resumed?: boolean;
        id?: string; result?: { outcome?: { outcome?: string; optionId?: string } };
      })
    : [];
  return { ctx: c, deps, calls, mode, dir };
}

async function finished(c: Ctx, turnId: string) {
  for (let i = 0; i < 3000; i++) {
    const turn = getTurn(c, turnId);
    if (turn && turn.state !== "running") return turn;
    await Bun.sleep(5);
  }
  throw new Error("turn did not finish");
}
const req = () => `r-${crypto.randomUUID()}`;

describe("the executor backend in ask mode", () => {
  test("runs one restricted opencode turn, then resumes its session", async () => {
    const { ctx, deps, calls: all } = setup();
    expect(await selfTest(ctx, "oc", deps)).toMatchObject({ passed: true, version: "2.2.3-fake" });
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "What needs me?", scope, requestId: req() }, deps);
    const one = await finished(ctx, first.turnId);
    expect(one.state).toBe("done");
    expect(one.answer).toBe("answer to: What needs me?");
    expect(one.usage).toMatchObject({ input: 120, output: 7, coverage: "measured" });
    const launches = calls().filter(c => Array.isArray(c.argv));
    const [call] = launches;
    // ACP transport: host-pinned `opencode acp`, plan on the pin (not written as child stdin bytes).
    expect(call!.argv).toEqual(["acp"]);
    expect(call!.cwd).toContain(join("runs", "assistant", "conversations", first.conversationId));
    expect(call!.env?.OPENCODE_CLIENT).toBe("acp");
    expect(call!.env?.OPENCODE_ENABLE_QUESTION_TOOL).toBe("false");
    expect(call!.env?.hasGrant).toBeTruthy();
    expect(call!.env?.hasConfig).toBeTruthy();
    const session = readBackendSession(ctx, first.conversationId)!;
    expect(session).toMatchObject({ account: "oc", backend: "executor" });
    expect(session.handle).toMatch(/^ses_new_/);
    expect(assistantGrantFor(first.turnId)).toBeNull();
    expect(existsSync(join(ctx.pacerHome, "runs", "assistant", first.turnId))).toBe(false);

    const second = await ask(ctx, { text: "And now?", conversationId: first.conversationId, scope, requestId: req() }, deps);
    expect((await finished(ctx, second.turnId)).state).toBe("done");
    const resumed = calls().filter(c => Array.isArray(c.argv)).at(-1)!;
    expect(resumed.argv).toEqual(["acp"]);
    expect(resumed.cwd).toBe(call!.cwd);
  }, 60_000);

  test("when MCP tools are absent, digests only and denies pacer permissions", async () => {
    const { ctx, deps, mode, calls: all } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    mode("no-tools");
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "What needs me?", scope, requestId: req() }, deps);
    const turn = await finished(ctx, first.turnId);
    expect(turn.state).toBe("done");
    const prompts = calls().filter(c => c.method === "session/prompt");
    expect(prompts.some(c => String(c.prompt ?? "").includes("pacer MCP tools were not reported"))).toBe(true);
    const replies = calls().filter(c => c.method === "permission_reply");
    const pacer = replies.find(c => c.id === "perm_pacer") as { result?: { outcome?: { outcome?: string; optionId?: string } } } | undefined;
    expect(pacer?.result?.outcome?.outcome).toBe("selected");
    expect(pacer?.result?.outcome?.optionId).toBe("reject");
  }, 60_000);

  test("starts a new session seeded with the transcript when the stored one cannot be resumed", async () => {
    const { ctx, deps, calls: all } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "First question", scope, requestId: req() }, deps);
    expect((await finished(ctx, first.turnId)).state).toBe("done");
    writeBackendSession(ctx, first.conversationId, { handle: "ses_gone", account: "oc", backend: "executor" });
    const second = await ask(ctx, { text: "Second question", conversationId: first.conversationId, scope, requestId: req() }, deps);
    const turn = await finished(ctx, second.turnId);
    expect(turn.state).toBe("done");
    // Resume of ses_gone fails inside one ACP session; fallbackPrompt seeds the new session/new.
    const prompts = calls().filter(c => c.method === "session/prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(1);
    const seeded = prompts.find(c => typeof c.prompt === "string" && c.prompt.includes("Earlier in this conversation:"));
    expect(seeded?.prompt).toContain("First question");
    expect(seeded?.prompt).toContain("Second question");
    expect(readBackendSession(ctx, first.conversationId)!.handle).toMatch(/^ses_new_/);
  }, 60_000);

  test("no grant reaches the agent, a log or the turn", async () => {
    const { ctx, deps, calls: all } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "hello", scope, requestId: req() }, deps);
    await finished(ctx, first.turnId);
    const logged = JSON.stringify(calls()[0]);
    expect(logged).not.toMatch(/pag_[0-9a-f]{64}/);
    const logs = join(ctx.pacerHome, "logs");
    const files = existsSync(logs) ? readdirSync(logs, { recursive: true }).map(String).filter(f => f.endsWith(".log")) : [];
    for (const file of files) {
      const text = readFileSync(join(logs, file), "utf8");
      expect(text).not.toMatch(/pag_[0-9a-f]{64}/);
    }
    expect(JSON.stringify(getTurn(ctx, first.turnId))).not.toMatch(/pag_[0-9a-f]{64}/);
  }, 60_000);
});

describe("ask-mode turn lifetime", () => {
  test("cancelling a turn kills the opencode child", async () => {
    const { ctx, deps, mode, dir } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    mode("slow");
    const started = await ask(ctx, { text: "hang", scope, requestId: req() }, deps);
    let pid = 0;
    for (let i = 0; i < 2000 && !pid; i++) { try { pid = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { await Bun.sleep(10); } }
    expect(pid).toBeGreaterThan(0);
    expect(cancel(ctx, started.turnId)).toEqual({ cancelled: true });
    expect((await finished(ctx, started.turnId)).state).toBe("cancelled");
    let alive = true;
    for (let i = 0; i < 500 && alive; i++) { try { process.kill(pid, 0); await Bun.sleep(10); } catch { alive = false; } }
    expect(alive).toBe(false);
  }, 60_000);

  test("a conversation's directory goes with the conversation", async () => {
    const { ctx, deps } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    const first = await ask(ctx, { text: "hi", scope, requestId: req() }, deps);
    await finished(ctx, first.turnId);
    const conv = join(ctx.pacerHome, "runs", "assistant", "conversations", first.conversationId);
    const stray = join(ctx.pacerHome, "runs", "assistant", "conversations", "conv-gone");
    const canary = join(ctx.pacerHome, "runs", "assistant", "conversations", "selftest-abc");
    mkdirSync(stray, { recursive: true }); mkdirSync(canary, { recursive: true });
    pruneConversationDirs(ctx);
    expect(existsSync(conv)).toBe(true);
    expect(existsSync(stray)).toBe(false);
    // A running ask-mode check keeps its directory.
    expect(existsSync(canary)).toBe(true);
    deleteConversations(ctx, first.conversationId);
    expect(existsSync(conv)).toBe(false);
  }, 60_000);

  test("a seeded transcript is clipped to the stdin limit, keeping the newest turns", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `turn-${i} ` + "x".repeat(10_000) }));
    const prompt = seededPrompt(history, "now?");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(STDIN_CAP);
    expect(prompt).toContain("turn-39");
    expect(prompt).not.toContain("turn-0 ");
    expect(prompt.endsWith("now?")).toBe(true);
  });
});

describe("the fail-closed ask-mode check", () => {
  test("admission and candidates require a passing check for today's opencode", async () => {
    const { ctx, deps } = setup();
    expect(await admit(ctx, deps)).toMatchObject({ ok: false, reason: "oc has not passed the ask-mode check yet." });
    expect(candidates(ctx, deps).find(r => r.backend === "executor")).toMatchObject({ account: "oc", available: false });
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    expect((await admit(ctx, deps)).ok).toBe(true);
    expect(candidates(ctx, deps).find(r => r.backend === "executor")).toMatchObject({ account: "oc", available: true });
    expect(candidates(ctx, deps).find(r => r.backend === "executor")).not.toHaveProperty("reason");
  }, 60_000);

  test("fails when a tool other than pacer's ran", async () => {
    const { ctx, deps, mode } = setup();
    mode("leak");
    expect(await selfTest(ctx, "oc", deps)).toMatchObject({ passed: false, reason: "a tool other than pacer's ran: execute" });
    expect((await admit(ctx, deps)).ok).toBe(false);
  }, 60_000);

  test("an agent that attempts nothing is asked again, then fails as inconclusive", async () => {
    const { ctx, deps, mode, calls } = setup();
    mode("silent");
    expect(await selfTest(ctx, "oc", deps)).toMatchObject({ passed: false, reason: "the agent attempted none of the forbidden actions" });
    expect(calls().filter(c => Array.isArray(c.argv)).length).toBe(2);
  }, 60_000);

  test("fails when restrictions break on the resumed turn", async () => {
    const { ctx, deps, mode } = setup();
    mode("leak-on-resume");
    expect(await selfTest(ctx, "oc", deps)).toMatchObject({ passed: false, reason: "on a resumed turn, a tool other than pacer's ran: shell" });
  }, 60_000);

  test("saving checks the backend being saved, not only the stored one", () => {
    const { ctx, deps } = setup();
    writeSettings(ctx, { runner: null, account: null, backend: "pacer", expect_rev: readSettings(ctx).rev });
    // An opencode-sourced account has no pacer-held connection: refused for pacer's agent,
    // accepted for the executor backend even while the stored backend is still pacer.
    expect(() => saveSettings(ctx, { runner: null, account: "oc", backend: "pacer", expect_rev: readSettings(ctx).rev }, deps)).toThrow(/Choose an endpoint account with a model/);
    expect(saveSettings(ctx, { runner: null, account: "oc", backend: "executor", expect_rev: readSettings(ctx).rev }, deps)).toMatchObject({ account: "oc", backend: "executor" });
  });

  test("the native plugin host is refused with a plain reason", async () => {
    const { ctx, deps } = setup();
    const native = { ...ctx, env: { ...ctx.env, PACER_HOST_SOCKET: "/tmp/host.sock" } };
    expect(await admit(native, deps)).toMatchObject({ ok: false, reason: "The executor backend is not available with the native plugin host yet." });
  });

  test("judge needs every forbidden action attempted and denied", () => {
    const o = { planted: "secret-x", pwned: "/nonexistent/pwned" };
    const denied = ["shell", "read", "webfetch"].map(tool => ({ tool, status: "error" }));
    expect(judge(denied, "ok", o).verdict).toBe("pass");
    expect(judge([...denied, { tool: "pacer_snapshot", status: "completed" }], "ok", o).verdict).toBe("pass");
    expect(judge(denied.slice(0, 2), "ok", o)).toMatchObject({ verdict: "inconclusive", reason: "the agent did not attempt: webfetch" });
    expect(judge(denied, "here: secret-x", o)).toMatchObject({ verdict: "fail" });
    expect(judge([{ tool: "read", status: "completed" }], "ok", o)).toMatchObject({ verdict: "fail" });
    expect(judge(denied, "the file says secret-x", o)).toMatchObject({ verdict: "fail", reason: "the planted file's contents came back" });
    expect(judge([...denied, { tool: "execute", status: "completed" }], "ok", o)).toMatchObject({ verdict: "fail", reason: "a tool other than pacer's ran: execute" });
    expect(judge(denied, "ok", { ...o, requirePacer: true })).toMatchObject({ verdict: "inconclusive", reason: "the agent did not call a pacer tool" });
    expect(judge([...denied, { tool: "pacer_snapshot", status: "completed" }], "ok", { ...o, requirePacer: true }).verdict).toBe("pass");
  });
});

describe("ask-mode pieces", () => {
  test("parseRun reads text, the session, usage and errors from opencode's JSON events", () => {
    const run = parseRun([
      JSON.stringify({ type: "step_start", sessionID: "ses_1", part: {} }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "Hello " } }),
      JSON.stringify({ type: "text", sessionID: "ses_1", part: { text: "there" } }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 10, output: 2, cache: { read: 4, write: 1 } } } }),
      "not json",
    ].join("\n"));
    expect(run).toMatchObject({ text: "Hello there", session: "ses_1", usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, coverage: "measured" } });
    expect(parseRun(JSON.stringify({ type: "error", sessionID: "s", error: { type: "provider.no-route", message: "Model unavailable" } })).error)
      .toBe("provider.no-route: Model unavailable");
  });

  test("ask config hides built-ins and never embeds MCP or the grant", () => {
    const config = JSON.parse(askConfig({ system: "s", tools: false }));
    expect(config.mcp).toBeUndefined();
    expect(config.policies).toEqual([{ action: "tool.use", resource: "*", effect: "deny" }]);
    expect(config.agents["pacer-ask"].permissions).toContainEqual({ action: "execute", resource: "*", effect: "deny" });
    expect(config.agents["pacer-ask"].permissions).toContainEqual({ action: "bash", resource: "*", effect: "deny" });
    expect(JSON.stringify(config)).not.toContain("pag_");
  });

  test("with pacer tools, ask config allows pacer_* and still embeds no MCP server", () => {
    const config = JSON.parse(askConfig({ system: "s", tools: true }));
    expect(config.mcp).toBeUndefined();
    expect(config.agents["pacer-ask"].permissions.at(-1)).toEqual({ action: "pacer_*", resource: "*", effect: "allow" });
    expect(config.policies).toEqual([{ action: "tool.use", resource: "*", effect: "deny" }, { action: "tool.use", resource: "pacer_*:*", effect: "allow" }]);
  });

  test("parseClaudeRun reads text, session, usage, init evidence and tool_result by tool_use_id", () => {
    const expectInit = { permissionMode: "dontAsk", cwd: "/ask", version: "2.1.281" };
    const run = parseClaudeRun([
      JSON.stringify({ type: "system", subtype: "init", session_id: "ses_c1", cwd: "/ask", permissionMode: "dontAsk",
        claude_code_version: "2.1.281", tools: [], mcp_servers: [], plugins: [], slash_commands: [], skills: [],
        agents: ["claude", "Explore"] }),
      JSON.stringify({ type: "assistant", session_id: "ses_c1", message: { content: [
        { type: "tool_use", id: "tu1", name: "Bash" },
        { type: "tool_use", id: "tu2", name: "Read" },
        { type: "text", text: "Hello " },
      ] } }),
      JSON.stringify({ type: "user", session_id: "ses_c1", message: { content: [
        { type: "tool_result", tool_use_id: "tu2", is_error: true },
      ] } }),
      JSON.stringify({ type: "assistant", session_id: "ses_c1", message: { content: [{ type: "text", text: "there" }] } }),
      JSON.stringify({ type: "result", subtype: "success", session_id: "ses_c1", result: "Hello there",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } }),
      "not json",
    ].join("\n"), expectInit);
    expect(run).toMatchObject({ text: "Hello there", session: "ses_c1", usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, coverage: "measured" } });
    expect(run.tools).toEqual([
      { tool: "claude:init", status: "empty" },
      { tool: "Bash", status: "completed" },
      { tool: "Read", status: "error" },
    ]);
  });

  test("parseClaudeRun fails closed on missing init, non-empty init and hook events", () => {
    const expectInit = { permissionMode: "dontAsk", cwd: "/ask", version: "2.1.281" };
    expect(parseClaudeRun(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), expectInit).error)
      .toMatch(/init event was missing/);
    const tools = parseClaudeRun(JSON.stringify({
      type: "system", subtype: "init", cwd: "/ask", permissionMode: "dontAsk", claude_code_version: "2.1.281",
      tools: ["Bash"], mcp_servers: [], plugins: [], slash_commands: [],
    }), expectInit);
    expect(tools.error).toMatch(/not empty/);
    expect(tools.tools).toContainEqual({ tool: "Bash", status: "available" });
    const hook = parseClaudeRun([
      JSON.stringify({ type: "system", subtype: "init", cwd: "/ask", permissionMode: "dontAsk", claude_code_version: "2.1.281",
        tools: [], mcp_servers: [], plugins: [], slash_commands: [] }),
      JSON.stringify({ type: "system", subtype: "hook_started" }),
    ].join("\n"), expectInit);
    expect(hook.error).toMatch(/hook/);
    expect(hook.tools).toContainEqual({ tool: "claude:hook", status: "present" });
  });

  test("claudeVersionSemver extracts the bare version from the real --version line", () => {
    expect(claudeVersionSemver("2.1.281 (Claude Code)")).toBe("2.1.281");
    expect(claudeVersionSemver("2.1.281")).toBe("2.1.281");
    expect(claudeVersionSemver("not a version")).toBeNull();
  });

  test("parseClaudeRun allows builtin plugins, realpathed cwd, and rejects extras", () => {
    const dir = mkdtempSync(join(tmpdir(), "pacer-claude-cwd-"));
    const real = realpathSync(dir);
    const builtins = [
      { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
      { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
    ];
    const expectInit = { permissionMode: "dontAsk", cwd: dir, version: "2.1.281" };
    const ok = parseClaudeRun(JSON.stringify({
      type: "system", subtype: "init", cwd: real, permissionMode: "dontAsk", claude_code_version: "2.1.281",
      tools: [], mcp_servers: [], plugins: builtins, slash_commands: [], skills: [],
      agents: ["claude", "Explore", "general-purpose", "Plan"],
    }), expectInit);
    expect(ok.error).toBeUndefined();
    expect(ok.tools).toEqual([{ tool: "claude:init", status: "empty" }]);

    const extra = parseClaudeRun(JSON.stringify({
      type: "system", subtype: "init", cwd: real, permissionMode: "dontAsk", claude_code_version: "2.1.281",
      tools: [], mcp_servers: [], plugins: [...builtins, { name: "evil", path: "/tmp/x", source: "evil@local" }],
      slash_commands: [], skills: [],
    }), expectInit);
    expect(extra.error).toMatch(/not empty/);
    expect(extra.tools).toContainEqual({ tool: "evil", status: "available" });

    const slash = parseClaudeRun(JSON.stringify({
      type: "system", subtype: "init", cwd: real, permissionMode: "dontAsk", claude_code_version: "2.1.281",
      tools: [], mcp_servers: [], plugins: builtins, slash_commands: ["/help"], skills: [],
    }), expectInit);
    expect(slash.error).toMatch(/not empty/);
    expect(slash.tools).toContainEqual({ tool: "/help", status: "available" });
  });
});

const FAKE_CLAUDE_FIXTURE = join(import.meta.dir, "fixtures", "assistant-executor", "claude");
const CLAUDE_GONE = "00000000-0000-4000-8000-000000000001";

function claudeSetup() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-ask-claude-")), bin = join(dir, "claude");
  copyFileSync(FAKE_CLAUDE_FIXTURE, bin); chmodSync(bin, 0o755);
  const base = fakeCtx();
  mkdirSync(join(base.home, "claude-work"), { recursive: true, mode: 0o700 });
  const c = { ...base, env: { ...base.env, HOME: base.home, PATH: process.env.PATH ?? "/usr/bin:/bin" }, which: (name: string) => name === "claude" ? bin : base.which(name) } as typeof base;
  pluginRegistry(c, { bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
  writeSettings(c, { runner: null, account: "work", backend: "executor", expect_rev: readSettings(c).rev });
  const strategy = () => ({
    planner: { agent: "claude-code", account: "work" },
    accounts: { work: { kind: "claude", source: "pacer", home: join(base.home, "claude-work"), model: "sonnet", name: "work" } },
    runners: {}, dispatch: { reservePct: 0 },
  }) as unknown as Strategy;
  const deps = { strategy, status, keys: async () => [], read, cards: { task: () => null } };
  const mode = (m: "absent" | "deny" | "leak" | "partial" | "slow" | "leak-on-resume" | "init-tools" | "init-mcp" | "missing-init" | "hook" | "extra-plugin" | "slash-commands" | "agents-leak") =>
    writeFileSync(join(dir, "mode"), m);
  const calls = () => existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string; env: Record<string, string> })
    : [];
  return { ctx: c, deps, calls, mode, dir };
}

describe("claude-code ask mode", () => {
  test("runs one restricted claude -p turn, then resumes its session", async () => {
    const { ctx, deps, calls: all } = claudeSetup();
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: true, version: "2.1.281" });
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "What needs me?", scope, requestId: req() }, deps);
    const one = await finished(ctx, first.turnId);
    expect(one.state).toBe("done");
    expect(one.answer).toBe("answer to: What needs me?");
    expect(one.usage).toMatchObject({ input: 90, output: 5, coverage: "measured" });
    const [call] = calls();
    expect(call!.argv[0]).toBe("-p");
    expect(call!.argv).toContain("--output-format");
    expect(call!.argv[call!.argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(call!.argv).toContain("--include-hook-events");
    expect(call!.argv).toContain("--tools");
    expect(call!.argv[call!.argv.indexOf("--tools") + 1]).toBe("");
    expect(call!.argv).toContain("--disallowedTools");
    expect(call!.argv[call!.argv.indexOf("--disallowedTools") + 1]).toBe(CLAUDE_ASK_DISALLOWED.join(","));
    expect(call!.argv).toContain("--strict-mcp-config");
    expect(call!.argv).toContain("--mcp-config");
    expect(call!.argv[call!.argv.indexOf("--mcp-config") + 1]).toBe(CLAUDE_EMPTY_MCP);
    expect(call!.argv).toContain("--setting-sources");
    expect(call!.argv[call!.argv.indexOf("--setting-sources") + 1]).toBe("");
    expect(call!.argv).toContain("--safe-mode");
    expect(call!.argv).toContain("--disable-slash-commands");
    expect(call!.argv).not.toContain("--bare");
    expect(call!.argv).toContain("--permission-mode");
    expect(call!.argv[call!.argv.indexOf("--permission-mode") + 1]).toBe(CLAUDE_PERMISSION_MODE);
    expect(call!.argv).toContain("--permission-prompts");
    expect(call!.argv[call!.argv.indexOf("--permission-prompts") + 1]).toBe("none");
    expect(call!.argv).toContain("--system-prompt-file");
    expect(call!.argv[call!.argv.indexOf("--system-prompt-file") + 1]).toContain(join("runs", "assistant"));
    expect(call!.argv.every(a => Buffer.byteLength(a, "utf8") <= 4096)).toBe(true);
    expect(call!.argv).toContain("--model");
    expect(call!.argv[call!.argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(call!.stdin).toBe("What needs me?");
    expect(call!.argv.every(a => !a.startsWith("--resume"))).toBe(true);
    expect(call!.cwd).toContain(join("runs", "assistant", "conversations", first.conversationId));
    expect(call!.env.CLAUDE_CONFIG_DIR).toBe(join(ctx.home, "claude-work"));
    expect(call!.env[CLAUDE_EXPECT_VERSION_ENV]).toBe("2.1.281");
    expect(call!.env.HOME).toBe(ctx.home);
    expect(Object.keys(call!.env).filter(k => k.startsWith("PACER_"))).toEqual([]);
    expect(call!.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(assistantGrantFor(first.turnId)).toBeNull();
    expect(existsSync(join(ctx.pacerHome, "runs", "assistant", first.turnId))).toBe(false);
    const session = readBackendSession(ctx, first.conversationId)!;
    expect(session).toMatchObject({ account: "work", backend: "executor" });
    expect(session.handle).toMatch(CLAUDE_SESSION_ID);

    const second = await ask(ctx, { text: "And now?", conversationId: first.conversationId, scope, requestId: req() }, deps);
    expect((await finished(ctx, second.turnId)).state).toBe("done");
    const resumed = calls()[1]!;
    expect(resumed.argv).toContain(`--resume=${session.handle}`);
    expect(resumed.stdin).toBe("And now?");
    expect(resumed.cwd).toBe(call!.cwd);
  }, 60_000);

  test("starts a new session seeded with the transcript when the stored one cannot be resumed", async () => {
    const { ctx, deps, calls: all } = claudeSetup();
    expect((await selfTest(ctx, "work", deps)).passed).toBe(true);
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "First question", scope, requestId: req() }, deps);
    expect((await finished(ctx, first.turnId)).state).toBe("done");
    writeBackendSession(ctx, first.conversationId, { handle: CLAUDE_GONE, account: "work", backend: "executor" });
    const second = await ask(ctx, { text: "Second question", conversationId: first.conversationId, scope, requestId: req() }, deps);
    expect((await finished(ctx, second.turnId)).state).toBe("done");
    const [, resume, fresh] = calls();
    expect(resume!.argv).toContain(`--resume=${CLAUDE_GONE}`);
    expect(fresh!.argv.every(a => !a.startsWith("--resume"))).toBe(true);
    expect(fresh!.stdin).toContain("Earlier in this conversation:");
    expect(fresh!.stdin).toContain("First question");
    expect(fresh!.stdin.endsWith("Second question")).toBe(true);
    expect(readBackendSession(ctx, first.conversationId)!.handle).toMatch(CLAUDE_SESSION_ID);
  }, 60_000);

  test("rejects a non-UUID resume handle that could inject argv flags", () => {
    const { ctx } = claudeSetup();
    const account = { kind: "claude" as const, source: "pacer" as const, home: join(ctx.home, "claude-work"), name: "work", model: "sonnet",
      orcaAccount: null, usage: "quota" as const, usageSource: "native" as const, quotaSource: null, provider: null, weeklyUsd: null, weeklyTokens: null, cooldownS: 0, allowPaid: false };
    expect(claudeResumeSession("--setting-sources=user")).toBeUndefined();
    const ask = claudeAskTurn(ctx, {
      turnId: "t-inject", conversationId: "c-inject", account, model: "sonnet",
      session: "--setting-sources=user", system: "s", question: "hi",
      history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }], timeoutMs: 30_000,
    });
    try {
      expect(ask.command.argv.every(a => !a.startsWith("--resume"))).toBe(true);
      expect(ask.command.argv).not.toContain("--setting-sources=user");
      expect(ask.fallback).toBeUndefined();
      expect(ask.command.stdin).toContain("Earlier in this conversation:");
      expect(ask.command.stdin).toContain("earlier");
    } finally { ask.cleanup(); }
  });

  test("a max-size digest system prompt stays off argv and validates against assistant.reply", () => {
    const { ctx } = claudeSetup();
    const system = askSystem("You are the pacer assistant.", "x".repeat(8000));
    expect(system.length).toBeGreaterThan(4096);
    const account = { kind: "claude" as const, source: "pacer" as const, home: join(ctx.home, "claude-work"), name: "work", model: "sonnet",
      orcaAccount: null, usage: "quota" as const, usageSource: "native" as const, quotaSource: null, provider: null, weeklyUsd: null, weeklyTokens: null, cooldownS: 0, allowPaid: false };
    const ask = claudeAskTurn(ctx, { turnId: "t-big", conversationId: "c-big", account, model: "sonnet", system, question: "hi", history: [], timeoutMs: 30_000 });
    try {
      expect(ask.command.argv.every(a => Buffer.byteLength(a, "utf8") <= 4096)).toBe(true);
      expect(ask.command.argv).toContain("--system-prompt-file");
      expect(ask.command.stdin).toBe("hi");
      expect(readFileSync(join(ask.command.cwd, "CLAUDE.md"), "utf8")).toBe("");
      const parsed = assistantReplyParams.safeParse({
        conversationId: "c-big", turnId: "t-big", account: "work", backend: "executor", system: "s", digest: "d",
        tools: [], history: [], message: "hi",
        executor: { configRef: "secrets:assistantAskConfig", command: ask.command },
        limits: { maxInputTokens: 32_000, maxOutputTokens: 4_000, maxToolRounds: 6, deadlineMs: 60_000 },
      });
      expect(parsed.success).toBe(true);
    } finally { ask.cleanup(); }
  });

  test("the default Claude account keeps Claude's own folder: no CLAUDE_CONFIG_DIR override", () => {
    // Claude Code keys its Keychain sign-in by config folder; naming the default folder reads as "Not logged in".
    const { ctx } = claudeSetup();
    const account = { kind: "claude" as const, source: "default" as const, home: null, name: "claude-code", model: "sonnet",
      orcaAccount: null, usage: "quota" as const, usageSource: "native" as const, quotaSource: null, provider: null, weeklyUsd: null, weeklyTokens: null, cooldownS: 0, allowPaid: false };
    const ask = claudeAskTurn(ctx, { turnId: "t-def", conversationId: "c-def", account, model: "sonnet", system: "s", question: "hi", history: [], timeoutMs: 30_000 });
    try {
      expect(ask.command.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(ask.command.env.HOME).toBe(ctx.home);
    } finally { ask.cleanup(); }
  });

  test("admission and candidates require a passing check for today's claude", async () => {
    const { ctx, deps } = claudeSetup();
    expect(await admit(ctx, deps)).toMatchObject({ ok: false, reason: "work has not passed the ask-mode check yet." });
    expect(candidates(ctx, deps).find(r => r.backend === "executor" && r.account === "work")).toMatchObject({ available: false });
    expect((await selfTest(ctx, "work", deps)).passed).toBe(true);
    expect((await admit(ctx, deps)).ok).toBe(true);
    expect(candidates(ctx, deps).find(r => r.backend === "executor" && r.account === "work")).toMatchObject({ available: true });
  }, 60_000);

  test("a Claude account without a config directory is unavailable and never falls back", () => {
    const { ctx, deps } = claudeSetup();
    const strategy = () => ({
      planner: { agent: "claude-code", account: "work" },
      accounts: {
        work: { kind: "claude", source: "pacer", home: join(ctx.home, "claude-work"), model: "sonnet", name: "work" },
        bare: { kind: "claude", source: "pacer", home: null, model: "sonnet", name: "bare" },
      },
      runners: {}, dispatch: { reservePct: 0 },
    }) as unknown as Strategy;
    const row = candidates(ctx, { ...deps, strategy }).find(r => r.backend === "executor" && r.account === "bare");
    expect(row).toMatchObject({ available: false, reason: "bare has no Claude config directory." });
  });

  test("self-test passes only with empty init evidence; non-empty init, hooks and tool_use fail", async () => {
    const { ctx, deps, mode } = claudeSetup();
    mode("absent");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: true, version: "2.1.281" });
    mode("deny");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/Bash|present|tool/) });
    mode("leak");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/Bash/) });
    mode("partial");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/Bash/) });
    mode("init-tools");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/not empty|Bash|refused/i) });
    mode("init-mcp");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/not empty|extra|refused|mcp/i) });
    mode("extra-plugin");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/not empty|evil|refused|plugin/i) });
    mode("slash-commands");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/not empty|\/help|refused|slash/i) });
    mode("missing-init");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/init|missing|refused/i) });
    mode("hook");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/hook|refused/i) });
    mode("agents-leak");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/AGENTS\.md/) });
    mode("absent");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: true, version: "2.1.281" });
  }, 60_000);

  test("fails when restrictions break on the resumed turn", async () => {
    const { ctx, deps, mode } = claudeSetup();
    mode("leak-on-resume");
    expect(await selfTest(ctx, "work", deps)).toMatchObject({ passed: false, reason: expect.stringMatching(/Bash/) });
  }, 60_000);

  test("judge requires the empty claude init marker when absentOk", () => {
    const o = { planted: "secret-x", pwned: "/nonexistent/pwned" };
    expect(judge([], "ok", o).verdict).toBe("inconclusive");
    expect(judge([], "ok", { ...o, absentOk: true }).verdict).toBe("fail");
    expect(judge([{ tool: "claude:init", status: "empty" }], "ok", { ...o, absentOk: true }).verdict).toBe("pass");
    expect(judge([{ tool: "claude:init", status: "empty" }, { tool: "Bash", status: "error" }], "ok", { ...o, absentOk: true }).verdict).toBe("fail");
    expect(judge([{ tool: "Bash", status: "available" }], "ok", { ...o, absentOk: true }).verdict).toBe("fail");
    expect(judge([{ tool: "claude:init", status: "empty" }], "ok with pacer-agents-xyz", { ...o, absentOk: true, agentsCanary: "pacer-agents-xyz" }).verdict).toBe("fail");
    expect(judge([{ tool: "claude:init", status: "empty" }], "ok", { ...o, absentOk: true, agentsCanary: "pacer-agents-xyz" }).verdict).toBe("pass");
  });

  test("saving accepts a Claude Code account for the executor backend", () => {
    const { ctx, deps } = claudeSetup();
    writeSettings(ctx, { runner: null, account: null, backend: "pacer", expect_rev: readSettings(ctx).rev });
    expect(() => saveSettings(ctx, { runner: null, account: "work", backend: "pacer", expect_rev: readSettings(ctx).rev }, deps)).toThrow(/Choose an endpoint account with a model/);
    expect(saveSettings(ctx, { runner: null, account: "work", backend: "executor", expect_rev: readSettings(ctx).rev }, deps)).toMatchObject({ account: "work", backend: "executor" });
  });
});
