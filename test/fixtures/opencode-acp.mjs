#!/usr/bin/env node
/**
 * Fake `opencode acp` for assistant-executor tests: JSON-RPC over stdio covering handshake,
 * tools present/absent, permission requests (allow pacer tool, deny bash), resume, and cancel.
 *
 * Modes (file `$FAKE_DIR/mode` or env FAKE_ACP_MODE):
 *   deny (default) — deny builtins, allow/complete a pacer tool, answer text
 *   leak — complete a non-pacer tool
 *   silent — no tool attempts
 *   no-tools — session/new _meta.mcpTools: [] (health fails)
 *   slow — hang until cancelled
 *   leak-on-resume — on session/load, leak a shell tool
 *   gone — session/load fails for ses_gone
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_DIR ?? import.meta.dirname;
const modeFile = `${dir}/mode`;
const mode = () => {
  try { return (process.env.FAKE_ACP_MODE || readFileSync(modeFile, "utf8")).trim(); } catch { return "deny"; }
};
const logPath = process.env.FAKE_LOG ?? `${dir}/calls.jsonl`;
const log = (row) => appendFileSync(logPath, JSON.stringify(row) + "\n");

function summarizeMcpServers(servers, { includeArgs = true } = {}) {
  return servers.map((s) => ({
    name: s?.name,
    command: s?.command,
    ...(includeArgs ? { args: s?.args } : {}),
    envKeys: Array.isArray(s?.env) ? s.env.map((e) => e?.name) : [],
  }));
}

if (process.argv.includes("--version")) {
  process.stdout.write("2.2.3-fake\n");
  process.exit(0);
}

log({ argv: process.argv.slice(2), cwd: process.cwd(), env: {
  OPENCODE_CLIENT: process.env.OPENCODE_CLIENT,
  OPENCODE_ENABLE_QUESTION_TOOL: process.env.OPENCODE_ENABLE_QUESTION_TOOL,
  hasGrant: Boolean(process.env.PACER_ASSISTANT_GRANT),
  hasConfig: Boolean(process.env.OPENCODE_CONFIG_CONTENT),
} });

const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
let sessionId = `ses_new_${Math.random().toString(36).slice(2, 8)}`;
let resumed = false;
let cancelled = () => {};
/** Pending permission request ids → resolve when the host replies. */
const pendingPerms = new Map();
const awaitPerm = (id) => new Promise((resolve) => {
  pendingPerms.set(id, resolve);
  setTimeout(() => { if (pendingPerms.delete(id)) resolve(null); }, 2_000);
});

async function prompt(frame) {
  const m = mode();
  if (m === "slow") {
    try { writeFileSync(`${dir}/pid`, String(process.pid)); } catch { /* ignore */ }
    await new Promise((resolve) => { cancelled = resolve; setTimeout(resolve, 30_000); });
    return send({ id: frame.id, result: { stopReason: "cancelled" } });
  }
  const update = (fields) => send({ method: "session/update", params: { sessionId, update: fields } });
  if (m === "leak-on-resume" && resumed) {
    update({ sessionUpdate: "tool_call", toolCallId: "t_shell", title: "shell", kind: "execute", status: "completed" });
  } else if (m === "deny" || m === "leak-on-resume" || m === "no-tools") {
    const permIds = [];
    for (const title of ["shell", "read", "webfetch"]) {
      update({ sessionUpdate: "tool_call", toolCallId: `t_${title}`, title, kind: "execute", status: "pending" });
      update({ sessionUpdate: "tool_call_update", toolCallId: `t_${title}`, title, status: "failed",
        content: [{ type: "content", content: { type: "text", text: "Blocked by configuration policy" } }] });
      const id = `perm_${title}`;
      permIds.push(id);
      send({
        jsonrpc: "2.0", id, method: "session/request_permission",
        params: {
          sessionId,
          toolCall: { toolCallId: `t_${title}`, title, kind: "execute", status: "pending", rawInput: { command: "echo x" } },
          options: [
            { optionId: "once", kind: "allow_once", name: "Allow once" },
            { optionId: "reject", kind: "reject_once", name: "Reject" },
          ],
        },
      });
    }
    // Spoof: pacer title with execute kind must be denied (title alone is not enough).
    permIds.push("perm_spoof");
    send({
      jsonrpc: "2.0", id: "perm_spoof", method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "t_spoof", title: "pacer_snapshot", kind: "execute", status: "pending", rawInput: { command: "echo x" } },
        options: [
          { optionId: "once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    // Even when health failed (no-tools), emit a pacer permission so the host must deny it.
    update({ sessionUpdate: "tool_call", toolCallId: "t_pacer", title: "pacer_snapshot", kind: "other", status: "pending" });
    permIds.push("perm_pacer");
    send({
      jsonrpc: "2.0", id: "perm_pacer", method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "t_pacer", title: "pacer_snapshot", kind: "other", status: "pending", rawInput: {} },
        options: [
          { optionId: "once", kind: "allow_once", name: "Allow once" },
          { optionId: "reject", kind: "reject_once", name: "Reject" },
        ],
      },
    });
    await Promise.all(permIds.map(awaitPerm));
    update({ sessionUpdate: "tool_call_update", toolCallId: "t_pacer", title: "pacer_snapshot",
      status: m === "no-tools" ? "failed" : "completed",
      content: [{ type: "content", content: { type: "text", text: m === "no-tools" ? "denied" : "{\"ok\":true}" } }] });
  }
  if (m === "leak") {
    update({ sessionUpdate: "tool_call", toolCallId: "t_exec", title: "execute", kind: "execute", status: "completed" });
  }
  const promptText = Array.isArray(frame.params?.prompt)
    ? frame.params.prompt.map((p) => p.text ?? "").join("")
    : "";
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `answer to: ${promptText.split("\n").at(-1) || promptText}` },
  });
  send({
    id: frame.id,
    result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127 } },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  // Permission replies from the host ACP client (id is string in our fake).
  if (frame.method === undefined) {
    if (frame.id != null) {
      log({ method: "permission_reply", id: frame.id, result: frame.result });
      const resolve = pendingPerms.get(frame.id);
      if (resolve) { pendingPerms.delete(frame.id); resolve(frame.result); }
    }
    return;
  }
  const reply = (result) => send({ id: frame.id, result });
  switch (frame.method) {
    case "initialize":
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: false } },
        agentInfo: { name: "OpenCode", version: "2.2.3-fake" },
      });
    case "session/new": {
      const m = mode();
      const servers = Array.isArray(frame.params?.mcpServers) ? frame.params.mcpServers : [];
      // Digest-only replacement sessions get a distinct id and no MCP tools meta.
      if (!servers.length && m === "no-tools") {
        sessionId = `ses_digest_${Math.random().toString(36).slice(2, 8)}`;
      } else {
        sessionId = `ses_new_${Math.random().toString(36).slice(2, 8)}`;
      }
      log({ method: "session/new", sessionId, mcpServers: summarizeMcpServers(servers) });
      const mcpTools = m === "no-tools" ? [] : ["pacer_snapshot", "pacer_status"];
      return reply({
        sessionId,
        configOptions: [],
        _meta: { mcpTools: servers.length ? mcpTools : [] },
      });
    }
    case "session/load": {
      if (frame.params?.sessionId === "ses_gone" || mode() === "gone") {
        return send({ id: frame.id, error: { code: -32000, message: "Session not found" } });
      }
      const servers = Array.isArray(frame.params?.mcpServers) ? frame.params.mcpServers : [];
      sessionId = frame.params.sessionId;
      resumed = true;
      log({ method: "session/load", sessionId, mcpServers: summarizeMcpServers(servers, { includeArgs: false }) });
      return reply({ modes: null });
    }
    case "session/prompt": {
      const promptText = Array.isArray(frame.params?.prompt)
        ? frame.params.prompt.map((p) => p.text ?? "").join("")
        : "";
      log({ method: "session/prompt", sessionId, resumed, prompt: promptText });
      return void prompt(frame);
    }
    case "session/cancel":
      cancelled();
      return;
    case "session/set_config_option": {
      log({ method: "session/set_config_option", params: frame.params });
      const value = frame.params?.value;
      return reply({
        configOptions: [{ id: frame.params?.configId ?? "model", currentValue: value }],
      });
    }
    // Legacy names kept so a regressing client fails loudly in logs if revived.
    case "session/set_model":
    case "session/setConfigOption":
      log({ method: frame.method, ignored: true });
      return send({ id: frame.id, error: { code: -32601, message: `"Method not found": ${frame.method}` } });
    default:
      if (frame.id !== undefined) return reply({});
  }
});
