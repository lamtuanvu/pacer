#!/usr/bin/env node
/**
 * Fake `codex … app-server` for assistant-executor tests: JSON-RPC over stdio covering initialize,
 * config/read with MCP servers, thread start/resume, approvals allow/deny, mcp status ok/failed,
 * a tool round, interrupt, and malformed input (fail closed via missing methods).
 *
 * Modes (file `$FAKE_DIR/mode` or env FAKE_CODEX_MODE):
 *   deny (default) — decline shell/file, allow pacer MCP, answer text
 *   leak — complete a non-pacer tool
 *   silent — no tool attempts and no pacer call
 *   no-tools — mcp status without pacer tools (health fails)
 *   slow — hang until cancelled / interrupted
 *   leak-on-resume — on resume, leak a shell tool
 *   gone — thread/resume fails for th_gone
 *   managed-mcp — config/read reports a managed layer re-enabling a server (refuse start)
 *   malformed — respond to initialize with garbage (fail closed)
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_DIR ?? import.meta.dirname;
const modeFile = `${dir}/mode`;
const mode = () => {
  try { return (process.env.FAKE_CODEX_MODE || readFileSync(modeFile, "utf8")).trim(); } catch { return "deny"; }
};
const logPath = process.env.FAKE_LOG ?? `${dir}/calls.jsonl`;
const log = (row) => appendFileSync(logPath, JSON.stringify(row) + "\n");

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.167.2-fake\n");
  process.exit(0);
}

log({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    hasGrant: Boolean(process.env.PACER_ASSISTANT_GRANT),
    hasCodexHome: Boolean(process.env.CODEX_HOME),
    CODEX_HOME: process.env.CODEX_HOME ?? null,
  },
});

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
let threadId = `th_new_${Math.random().toString(36).slice(2, 8)}`;
let resumed = false;
let activeTurnId = null;
let cancelled = () => {};
const pendingApprovals = new Map();
const awaitApproval = (id) => new Promise((resolve) => {
  pendingApprovals.set(id, resolve);
  setTimeout(() => { if (pendingApprovals.delete(id)) resolve(null); }, 2_000);
});

function notify(method, params) {
  send({ method, params });
}

async function runTurn(frame) {
  const m = mode();
  activeTurnId = `turn_${Math.random().toString(36).slice(2, 8)}`;
  send({ id: frame.id, result: { turn: { id: activeTurnId, status: "inProgress", items: [] } } });

  if (m === "slow") {
    try { writeFileSync(`${dir}/pid`, String(process.pid)); } catch { /* ignore */ }
    await new Promise((resolve) => { cancelled = resolve; setTimeout(resolve, 30_000); });
    notify("turn/completed", { threadId, turn: { id: activeTurnId, status: "interrupted", items: [] } });
    return;
  }

  if (m === "leak-on-resume" && resumed) {
    notify("item/started", { threadId, turnId: activeTurnId, item: { id: "i_shell", type: "commandExecution", status: "inProgress" } });
    notify("item/completed", { threadId, turnId: activeTurnId, item: { id: "i_shell", type: "commandExecution", status: "completed" } });
  } else if (m === "deny" || m === "leak-on-resume" || m === "no-tools") {
    for (const kind of ["shell", "write"]) {
      const id = `appr_${kind}`;
      send({
        jsonrpc: "2.0", id, method: kind === "shell" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval",
        params: {
          threadId, turnId: activeTurnId, itemId: `i_${kind}`,
          ...(kind === "shell" ? { command: "echo x" } : { changes: [] }),
        },
      });
      await awaitApproval(id);
    }
    const elicitId = "appr_pacer";
    send({
      jsonrpc: "2.0", id: elicitId, method: "mcpServer/elicitation/request",
      params: {
        serverName: "pacer", threadId, turnId: activeTurnId,
        mode: "form", message: "Allow pacer_snapshot?",
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
      },
    });
    await awaitApproval(elicitId);
    notify("item/started", {
      threadId, turnId: activeTurnId,
      item: { id: "i_pacer", type: "mcpToolCall", server: "pacer", tool: "snapshot", status: "inProgress" },
    });
    notify("item/completed", {
      threadId, turnId: activeTurnId,
      item: {
        id: "i_pacer", type: "mcpToolCall", server: "pacer", tool: "snapshot",
        status: m === "no-tools" ? "failed" : "completed",
      },
    });
  }
  if (m === "leak") {
    notify("item/completed", {
      threadId, turnId: activeTurnId,
      item: { id: "i_exec", type: "commandExecution", status: "completed" },
    });
  }

  const input = Array.isArray(frame.params?.input) ? frame.params.input : [];
  const promptText = input.map((p) => p.text ?? "").join("");
  const answer = `answer to: ${promptText.split("\n").at(-1) || promptText}`;
  for (const chunk of [answer.slice(0, 8), answer.slice(8)]) {
    if (!chunk) continue;
    notify("item/agentMessage/delta", { threadId, turnId: activeTurnId, itemId: "i_msg", delta: chunk });
  }
  notify("turn/completed", {
    threadId,
    turn: {
      id: activeTurnId, status: "completed", items: [],
      tokenUsage: { inputTokens: 110, outputTokens: 6 },
    },
  });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch {
    log({ method: "malformed_line", line: line.slice(0, 80) });
    return;
  }
  if (frame.method === undefined) {
    if (frame.id != null) {
      log({ method: "approval_reply", id: frame.id, result: frame.result, error: frame.error });
      const resolve = pendingApprovals.get(frame.id);
      if (resolve) { pendingApprovals.delete(frame.id); resolve(frame.result ?? frame.error); }
    }
    return;
  }
  if (frame.method === "initialized") {
    log({ method: "initialized" });
    return;
  }
  const reply = (result) => send({ id: frame.id, result });
  const fail = (message) => send({ id: frame.id, error: { code: -32600, message } });
  log({ method: frame.method, params: frame.params });
  switch (frame.method) {
    case "initialize":
      if (mode() === "malformed") {
        process.stdout.write("not-json\n");
        return;
      }
      return reply({ userAgent: "codex-fake" });
    case "config/read": {
      if (mode() === "managed-mcp") {
        return reply({
          config: { mcp_servers: { evil: { command: "evil", enabled: true } } },
          origins: {
            "mcp_servers.evil.enabled": { name: { type: "legacyManagedConfigTomlFromFile" } },
          },
        });
      }
      return reply({
        config: { mcp_servers: { other: { command: "other", enabled: true } } },
        origins: { "mcp_servers.other.enabled": { name: { type: "userConfigToml" } } },
      });
    }
    case "thread/start": {
      if (mode() === "managed-mcp") return fail("should not start");
      const cfg = frame.params?.config ?? {};
      log({ method: "thread_config", config: cfg });
      return reply({ thread: { id: threadId }, approvalPolicy: "on-request", sandbox: "read-only" });
    }
    case "thread/resume": {
      if (frame.params?.threadId === "th_gone" || mode() === "gone") {
        return fail(`no rollout found for thread id ${frame.params?.threadId}`);
      }
      threadId = frame.params.threadId;
      resumed = true;
      return reply({ thread: { id: threadId } });
    }
    case "mcpServerStatus/list": {
      if (mode() === "no-tools") {
        return reply({ data: [{ name: "pacer", runtimeStatus: "failed", tools: [] }] });
      }
      return reply({
        data: [{ name: "pacer", runtimeStatus: "connected", tools: { snapshot: {}, status: {} } }],
      });
    }
    case "turn/start":
      return runTurn(frame);
    case "turn/interrupt":
      cancelled();
      return reply({});
    default:
      return fail(`unknown method ${frame.method}`);
  }
});
