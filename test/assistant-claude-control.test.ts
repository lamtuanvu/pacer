import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  CLAUDE_CONTROL_PLAN_VERSION,
  isAllowedPacerTool,
  isClaudeControlArgv,
  mcpStatusHealthy,
  parseClaudeControlPlan,
  runClaudeControlTurn,
  type ClaudeControlPlan,
} from "../src/assistant/claude-control-turn";

/** Minimal host-shaped CONTROL argv (security belt + identity). */
function controlArgv(over: { omit?: string[]; replace?: Record<string, string>; digestOnly?: boolean } = {}): string[] {
  const flags = [
    "claude", "-p",
    "--input-format=stream-json",
    "--output-format=stream-json",
    "--verbose",
    "--include-hook-events",
    "--tools=",
    "--disallowedTools=Bash,Read,Write",
    "--strict-mcp-config",
    "--mcp-config={\"mcpServers\":{\"pacer\":{}}}",
    "--setting-sources=",
    "--settings={\"disableAllHooks\":true}",
    "--safe-mode",
    "--disable-slash-commands",
    "--permission-mode=dontAsk",
    "--permission-prompts=host",
    "--permission-prompt-tool=stdio",
    "--system-prompt-file=/tmp/system.txt",
    ...(over.digestOnly ? [] : ["--allowedTools=mcp__pacer__*"]),
  ];
  let out = flags.filter(f => !(over.omit ?? []).some(o => f === o || f.startsWith(`${o}=`)));
  if (over.replace) {
    out = out.map(f => {
      for (const [k, v] of Object.entries(over.replace!)) {
        if (f === k || f.startsWith(`${k}=`)) return v.startsWith("--") ? v : `${k}=${v}`;
      }
      return f;
    });
  }
  return out;
}

function fakeChild() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => boolean;
    pid: number;
  };
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.kill = () => { child.emit("close", 0); return true; };
  return { child, stdin, stdout, stderr };
}

function plan(over: Partial<ClaudeControlPlan> = {}): ClaudeControlPlan {
  return {
    v: CLAUDE_CONTROL_PLAN_VERSION,
    prompt: "What is open?",
    allowedTools: ["mcp__pacer__snapshot"],
    tools: true,
    permissionMode: "dontAsk",
    cwd: "/tmp/ask",
    expectVersion: "2.1.281",
    turnId: "t1",
    ...over,
  };
}

describe("claude control plan helpers", () => {
  test("parseClaudeControlPlan accepts a host plan and rejects malformed ones", () => {
    const ok = parseClaudeControlPlan(JSON.stringify(plan()));
    expect(ok?.prompt).toBe("What is open?");
    expect(parseClaudeControlPlan("{")).toBeNull();
    expect(parseClaudeControlPlan(JSON.stringify({ v: 1, prompt: "x" }))).toBeNull();
  });

  test("isAllowedPacerTool matches exact host-passed names only", () => {
    expect(isAllowedPacerTool(["mcp__pacer__snapshot"], "mcp__pacer__snapshot")).toBe(true);
    expect(isAllowedPacerTool(["mcp__pacer__snapshot"], "mcp__pacer__task_list")).toBe(false);
    expect(isAllowedPacerTool(["mcp__pacer__snapshot"], "Bash")).toBe(false);
  });

  test("mcpStatusHealthy requires connected pacer and the expected tools", () => {
    expect(mcpStatusHealthy(
      { mcpServers: [{ name: "pacer", status: "connected" }], tools: ["mcp__pacer__snapshot"] },
      ["mcp__pacer__snapshot"],
    )).toBe(true);
    // Status-only object / bare array cannot confirm tools when some are expected.
    expect(mcpStatusHealthy(
      { mcpServers: [{ name: "pacer", status: "connected" }] },
      ["mcp__pacer__snapshot"],
    )).toBe(false);
    expect(mcpStatusHealthy(
      [{ name: "pacer", status: "connected" }],
      ["mcp__pacer__snapshot"],
    )).toBe(false);
    expect(mcpStatusHealthy(
      { mcpServers: [{ name: "pacer", status: "connected" }], tools: ["mcp__pacer__snapshot", "Bash"] },
      ["mcp__pacer__snapshot"],
    )).toBe(false);
    expect(mcpStatusHealthy({ mcpServers: [{ name: "pacer", status: "failed" }] }, ["mcp__pacer__snapshot"])).toBe(false);
    expect(mcpStatusHealthy({ mcpServers: [] }, ["mcp__pacer__snapshot"])).toBe(false);
  });

  test("isClaudeControlArgv requires the full security flag belt", () => {
    expect(isClaudeControlArgv(controlArgv())).toBe(true);
    expect(isClaudeControlArgv(controlArgv({ digestOnly: true }))).toBe(true);
    // Identity without the belt fails closed.
    expect(isClaudeControlArgv([
      "claude", "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--verbose",
      "--permission-prompt-tool=stdio",
      "--permission-prompts=host",
    ])).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ omit: ["--safe-mode"] }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ omit: ["--strict-mcp-config"] }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ replace: { "--tools": "--tools=Bash" } }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ replace: { "--permission-mode": "--permission-mode=default" } }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ replace: { "--settings": "--settings={}" } }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ replace: { "--allowedTools": "--allowedTools=Bash" } }))).toBe(false);
    expect(isClaudeControlArgv(controlArgv({ omit: ["--disallowedTools"] }))).toBe(false);
  });
});

describe("runClaudeControlTurn", () => {
  test("initializes, checks mcp_status, allows pacer tools, denies builtins, streams text", async () => {
    const { child, stdin, stdout } = fakeChild();
    const linesP = new Promise<string[]>(resolve => {
      const lines: string[] = [];
      let buf = "";
      stdin.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        for (;;) {
          const i = buf.indexOf("\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          lines.push(line);
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === "control_request") {
            const req = msg.request as { subtype?: string };
            const request_id = String(msg.request_id);
            if (req.subtype === "initialize") {
              stdout.write(`${JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id, response: { commands: [], models: [], capabilities: [] } },
              })}\n`);
              stdout.write(`${JSON.stringify({
                type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111",
                cwd: "/tmp/ask", permissionMode: "dontAsk", claude_code_version: "2.1.281",
                tools: ["mcp__pacer__snapshot"],
                mcp_servers: [{ name: "pacer", status: "connected" }],
                plugins: [
                  { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
                  { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
                ],
                slash_commands: [], skills: [],
              })}\n`);
            } else if (req.subtype === "mcp_status") {
              stdout.write(`${JSON.stringify({
                type: "control_response",
                response: {
                  subtype: "success",
                  request_id,
                  response: { mcpServers: [{ name: "pacer", status: "connected" }], tools: ["mcp__pacer__snapshot"] },
                },
              })}\n`);
            }
          } else if (msg.type === "user") {
            // Builtin attempt → host must deny.
            stdout.write(`${JSON.stringify({
              type: "control_request",
              request_id: "req-bash",
              request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu_bash", input: { command: "id" } },
            })}\n`);
            // Pacer tool → host must allow.
            stdout.write(`${JSON.stringify({
              type: "control_request",
              request_id: "req-snap",
              request: { subtype: "can_use_tool", tool_name: "mcp__pacer__snapshot", tool_use_id: "tu_snap", input: {} },
            })}\n`);
          } else if (msg.type === "control_response") {
            const response = msg.response as { request_id?: string; response?: { behavior?: string } };
            if (response.request_id === "req-snap" && response.response?.behavior === "allow") {
              stdout.write(`${JSON.stringify({
                type: "assistant",
                session_id: "11111111-1111-4111-8111-111111111111",
                message: { content: [
                  { type: "tool_use", id: "tu_snap", name: "mcp__pacer__snapshot" },
                  { type: "text", text: "three open" },
                ] },
              })}\n`);
              stdout.write(`${JSON.stringify({
                type: "result", is_error: false, result: "three open",
                session_id: "11111111-1111-4111-8111-111111111111",
                usage: { input_tokens: 10, output_tokens: 4 },
              })}\n`);
              resolve(lines);
            }
          }
        }
      });
    });

    const deltas: string[] = [];
    const result = await runClaudeControlTurn(child as never, plan(), { onDelta: t => deltas.push(t) });
    await linesP;

    expect(result.toolsHealthy).toBe(true);
    expect(result.text).toBe("three open");
    expect(deltas).toContain("three open");
    expect(result.session).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.tools).toContainEqual({ tool: "claude:init", status: "pacer" });
    expect(result.tools).toContainEqual({ tool: "Bash", status: "denied" });
    expect(result.tools).toContainEqual({ tool: "mcp__pacer__snapshot", status: "completed" });
    expect(result.usage).toMatchObject({ input: 10, output: 4, coverage: "measured" });
  });

  test("falls back to digest-only when mcp_status is not connected", async () => {
    const { child, stdin, stdout } = fakeChild();
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type !== "control_request") {
          if (msg.type === "user") {
            stdout.write(`${JSON.stringify({
              type: "assistant", message: { content: [{ type: "text", text: "from digest" }] },
            })}\n`);
            stdout.write(`${JSON.stringify({
              type: "result", is_error: false, result: "from digest",
              usage: { input_tokens: 1, output_tokens: 1 },
            })}\n`);
          }
          continue;
        }
        const req = msg.request as { subtype?: string };
        const request_id = String(msg.request_id);
        if (req.subtype === "initialize") {
          stdout.write(`${JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id, response: {} },
          })}\n`);
          stdout.write(`${JSON.stringify({
            type: "system", subtype: "init", session_id: "22222222-2222-4222-8222-222222222222",
            cwd: "/tmp/ask", permissionMode: "dontAsk", claude_code_version: "2.1.281",
            tools: ["mcp__pacer__snapshot"],
            mcp_servers: [{ name: "pacer", status: "failed" }],
            plugins: [
              { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
              { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
            ],
            slash_commands: [], skills: [],
          })}\n`);
        } else if (req.subtype === "mcp_status") {
          stdout.write(`${JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id, response: { mcpServers: [{ name: "pacer", status: "failed" }] } },
          })}\n`);
        }
      }
    });

    const result = await runClaudeControlTurn(child as never, plan());
    expect(result.toolsHealthy).toBe(false);
    expect(result.text).toBe("from digest");
    expect(result.error).toMatch(/digest only/i);
  });

  test("fail closed on a malformed JSON line", async () => {
    const { child, stdout } = fakeChild();
    queueMicrotask(() => {
      stdout.write("not-json\n");
    });
    const result = await runClaudeControlTurn(child as never, plan({ tools: false }));
    expect(result.error).toMatch(/malformed/i);
  });

  test("interrupt on cancel then stops", async () => {
    const { child, stdin, stdout } = fakeChild();
    const ac = new AbortController();
    const seen: string[] = [];
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (msg.type === "control_request") {
          const req = msg.request as { subtype?: string };
          seen.push(req.subtype ?? "");
          const request_id = String(msg.request_id);
          stdout.write(`${JSON.stringify({
            type: "control_response",
            response: { subtype: "success", request_id, response: req.subtype === "mcp_status"
              ? { mcpServers: [{ name: "pacer", status: "connected" }], tools: ["mcp__pacer__snapshot"] }
              : {} },
          })}\n`);
          if (req.subtype === "initialize") {
            stdout.write(`${JSON.stringify({
              type: "system", subtype: "init", session_id: "33333333-3333-4333-8333-333333333333",
              cwd: "/tmp/ask", permissionMode: "dontAsk", claude_code_version: "2.1.281",
              tools: ["mcp__pacer__snapshot"],
              mcp_servers: [{ name: "pacer", status: "connected" }],
              plugins: [
                { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
                { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
              ],
              slash_commands: [], skills: [],
            })}\n`);
          }
          // Same path pin timeout uses: abort the turn signal → CONTROL interrupt then kill.
          if (req.subtype === "mcp_status") ac.abort();
        }
      }
    });
    const result = await runClaudeControlTurn(child as never, plan(), { signal: ac.signal });
    expect(seen).toContain("interrupt");
    expect(result.error).toMatch(/cancelled/i);
  });
});
