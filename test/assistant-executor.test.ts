import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED } from "../plugins/bundled";
import { parseRun } from "../plugins/assistant-executor/index";
import { admit, ask, assistantGrantFor, candidates, selfTest } from "../src/assistant/service";
import { judge } from "../src/assistant/selftest";
import { askConfig } from "../src/assistant/ask-mode";
import { getTurn, readBackendSession, readSettings, writeBackendSession, writeSettings } from "../src/assistant/store";
import type { AssistantScope } from "../src/assistant/types";
import type { Strategy } from "../src/config/strategy";
import type { Status } from "../src/engine/status";
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

/** A fake opencode: records each invocation, answers as `opencode run --format json`, and fails a resume of "ses_gone". */
const FAKE = `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("2.2.3-fake"); process.exit(0); }
const stdin = readFileSync(0, "utf8");
let mode = "deny"; try { mode = readFileSync("${"$"}{import.meta.dir}/mode", "utf8").trim(); } catch {}
appendFileSync(process.env.FAKE_LOG ?? "${"$"}{import.meta.dir}/calls.jsonl", JSON.stringify({ argv, cwd: process.cwd(), stdin, env: process.env }) + "\\n");
const at = argv.indexOf("--session"), session = at >= 0 ? argv[at + 1] : "ses_new_" + Math.random().toString(36).slice(2, 8);
const out = (o) => console.log(JSON.stringify({ timestamp: 1, sessionID: session, ...o }));
if (session === "ses_gone") { out({ type: "error", error: { type: "session.not-found", message: "Session not found" } }); process.exit(1); }
out({ type: "step_start", part: { type: "step-start" } });
if (mode === "deny") for (const tool of ["shell", "read", "webfetch"]) out({ type: "tool_use", part: { tool, state: { status: "error", error: "Blocked by configuration policy" } } });
if (mode === "leak") out({ type: "tool_use", part: { tool: "execute", state: { status: "completed", output: "ran" } } });
out({ type: "text", part: { type: "text", text: "answer to: " + stdin.split("\\n").at(-1) } });
out({ type: "step_finish", part: { type: "step-finish", tokens: { input: 120, output: 7, cache: { read: 30, write: 0 } } } });
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pacer-ask-")), bin = join(dir, "opencode");
  writeFileSync(bin, FAKE.replace("#!/usr/bin/env bun", `#!${process.execPath}`).replaceAll(`${"$"}{import.meta.dir}`, dir)); chmodSync(bin, 0o755);
  const base = fakeCtx();
  const c = { ...base, which: (name: string) => name === "opencode" ? bin : base.which(name) } as typeof base;
  pluginRegistry(c, { bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
  writeSettings(c, { runner: null, account: "oc", backend: "executor", expect_rev: readSettings(c).rev });
  const deps = { strategy: () => strategy(), status, keys: async () => [], read, cards: { task: () => null } };
  const mode = (m: "deny" | "leak" | "silent") => writeFileSync(join(dir, "mode"), m);
  const calls = () => existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l) as { argv: string[]; cwd: string; stdin: string; env: Record<string, string> })
    : [];
  return { ctx: c, deps, calls, mode };
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
    const [call] = calls();
    // Standalone, JSON, the restricted agent, the account's model, the question on stdin.
    expect(call!.argv).toEqual(["run", "--standalone", "--format", "json", "--agent", "pacer-ask", "--model", "opencode-go/glm-test", "--title", "pacer assistant"]);
    expect(call!.stdin).toBe("What needs me?");
    expect(call!.cwd).toContain(join("runs", "assistant", "conversations", first.conversationId));
    // Config travels by reference and arrives resolved; nothing of pacer's role leaks in.
    const config = JSON.parse(call!.env.OPENCODE_CONFIG_CONTENT!);
    expect(config.default_agent).toBe("pacer-ask");
    expect(config.agents["pacer-ask"].permissions).toEqual([{ action: "execute", resource: "*", effect: "deny" }, { action: "pacer_*", resource: "*", effect: "allow" }]);
    expect(config.policies[0]).toEqual({ action: "tool.use", resource: "*", effect: "deny" });
    // v1 is digest-only: no MCP server, every tool denied, and the agent is told it has no tools.
    expect(config.mcp).toBeUndefined();
    expect(config.policies).toEqual([{ action: "tool.use", resource: "*", effect: "deny" }]);
    expect(config.agents["pacer-ask"].system).toContain("You have no tools");
    expect(config.agents["pacer-ask"].system).toContain('"open":3');
    expect(config.instructions).toEqual([]);
    expect(config.plugins).toEqual([]);
    expect(Object.keys(call!.env).filter(k => k.startsWith("PACER_"))).toEqual([]);
    // The turn is over: its grant is revoked and its config directory is gone; the conversation keeps its empty directory to resume in.
    expect(assistantGrantFor(first.turnId)).toBeNull();
    expect(existsSync(join(ctx.pacerHome, "runs", "assistant", first.turnId))).toBe(false);
    expect(readdirSync(call!.cwd)).toEqual([]);
    const session = readBackendSession(ctx, first.conversationId)!;
    expect(session).toMatchObject({ account: "oc", backend: "executor" });
    expect(session.handle).toMatch(/^ses_new_/);

    const second = await ask(ctx, { text: "And now?", conversationId: first.conversationId, scope, requestId: req() }, deps);
    expect((await finished(ctx, second.turnId)).state).toBe("done");
    const resumed = calls()[1]!;
    expect(resumed.argv).toContain("--session");
    expect(resumed.argv[resumed.argv.indexOf("--session") + 1]).toBe(session.handle);
    expect(resumed.stdin).toBe("And now?");
    expect(resumed.cwd).toBe(call!.cwd);
    expect(JSON.parse(resumed.env.OPENCODE_CONFIG_CONTENT!).mcp).toBeUndefined();
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
    const [, resume, fresh] = calls();
    expect(resume!.argv[resume!.argv.indexOf("--session") + 1]).toBe("ses_gone");
    expect(fresh!.argv).not.toContain("--session");
    expect(fresh!.stdin).toContain("Earlier in this conversation:");
    expect(fresh!.stdin).toContain("First question");
    expect(fresh!.stdin.endsWith("Second question")).toBe(true);
    expect(readBackendSession(ctx, first.conversationId)!.handle).toMatch(/^ses_new_/);
  }, 60_000);

  test("no grant reaches the agent, a log or the turn", async () => {
    const { ctx, deps, calls: all } = setup();
    expect((await selfTest(ctx, "oc", deps)).passed).toBe(true);
    const skip = all().length, calls = () => all().slice(skip);
    const first = await ask(ctx, { text: "hello", scope, requestId: req() }, deps);
    await finished(ctx, first.turnId);
    expect(calls()[0]!.env.OPENCODE_CONFIG_CONTENT).not.toContain("pag_");
    const logs = join(ctx.pacerHome, "logs");
    const files = existsSync(logs) ? readdirSync(logs, { recursive: true }).map(String).filter(f => f.endsWith(".log")) : [];
    for (const file of files) expect(readFileSync(join(logs, file), "utf8")).not.toMatch(/pag_[0-9a-f]{64}/);
    expect(JSON.stringify(getTurn(ctx, first.turnId))).not.toMatch(/pag_[0-9a-f]{64}/);
  }, 60_000);
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
    expect(calls().length).toBe(2);
  }, 60_000);

  test("judge needs every forbidden action attempted and denied", () => {
    const o = { planted: "secret-x", pwned: "/nonexistent/pwned" };
    const denied = ["shell", "read", "webfetch"].map(tool => ({ tool, status: "error" }));
    expect(judge(denied, "ok", o).verdict).toBe("pass");
    expect(judge([...denied, { tool: "pacer_snapshot", status: "completed" }], "ok", o).verdict).toBe("pass");
    expect(judge(denied.slice(0, 2), "ok", o)).toMatchObject({ verdict: "inconclusive", reason: "the agent did not attempt: webfetch" });
    expect(judge(denied, "here: secret-x", o)).toMatchObject({ verdict: "fail" });
    expect(judge([{ tool: "read", status: "completed" }], "ok", o)).toMatchObject({ verdict: "fail" });
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

  test("v1's ask config denies every tool and loads no MCP server", () => {
    const config = JSON.parse(askConfig({ pacer: ["pacer"], grant: "pag_x", url: "http://127.0.0.1:1", turnId: "t", runDir: "/r", system: "s" }));
    expect(config.mcp).toBeUndefined();
    expect(config.policies).toEqual([{ action: "tool.use", resource: "*", effect: "deny" }]);
    expect(config.agents["pacer-ask"].permissions).toContainEqual({ action: "execute", resource: "*", effect: "deny" });
    expect(JSON.stringify(config)).not.toContain("pag_x");
  });

  test("with pacer's tools, the ask config denies Code Mode and lists only pacer's MCP server", () => {
    const config = JSON.parse(askConfig({ pacer: ["pacer"], grant: "pag_x", url: "http://127.0.0.1:1", turnId: "t", runDir: "/r", system: "s", tools: true }));
    expect(config.agents["pacer-ask"].permissions).toContainEqual({ action: "execute", resource: "*", effect: "deny" });
    expect(config.agents["pacer-ask"].permissions.at(-1)).toEqual({ action: "pacer_*", resource: "*", effect: "allow" });
    expect(config.policies).toEqual([{ action: "tool.use", resource: "*", effect: "deny" }, { action: "tool.use", resource: "pacer_*:*", effect: "allow" }]);
    expect(config.mcp.servers.pacer.environment).toEqual({ PACER_ASSISTANT_GRANT: "pag_x", PACER_ASSISTANT_URL: "http://127.0.0.1:1", PACER_ASSISTANT_TURN: "t", PACER_HOME: "/r" });
  });
});
