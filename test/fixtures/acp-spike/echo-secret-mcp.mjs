#!/usr/bin/env node
/**
 * Tiny stdio MCP server for the opencode ACP spike: one tool `echo_secret_word`
 * that returns a random word. Speaks MCP JSON-RPC over newline-delimited stdin/stdout.
 */
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";

const WORDS = ["amber", "cedar", "flint", "harbor", "maple", "onyx", "quartz", "ridge", "sable", "willow"];
const secret = WORDS[randomBytes(1)[0] % WORDS.length];
const TOOL = {
  name: "echo_secret_word",
  description: "Return the secret word for this process. Call with no arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const log = (line) => process.stderr.write(`[echo-secret-mcp] ${line}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "echo-secret", version: "0.0.1" },
      },
    });
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
  }
  if (method === "tools/call") {
    const name = params?.name;
    log(`tools/call name=${name}`);
    if (name !== "echo_secret_word") {
      return send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true },
      });
    }
    return send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: secret }] },
    });
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (id !== undefined) {
    return send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});

log(`ready secret=${secret}`);
