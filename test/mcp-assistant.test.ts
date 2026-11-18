import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { execProcess } from "../src/exec/process";
import { createMcpServer } from "../src/mcp/server";
import { createRedactor } from "../src/assistant/redact";
import { openAssistantTurnFor } from "../src/assistant/turn-tools";
import type { AssistantScope } from "../src/assistant/types";
import { toolDefinitions } from "../src/assistant/tools";
import { issueAssistantGrant } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// Phase 1B item 5: `pacer mcp --assistant` mirrors the scoped PACER_WORK_GRANT mode. It reads the
// service address and the grant from the environment, never a token file, and without a live grant
// it registers nothing usable and every call errors.

const GRANT = `pag_${"cd".repeat(32)}`;
const TURN = "turn-mcp000001";
const scope: AssistantScope = { kind: "dispatch", days: 7 };

/** The assistant's tools, exactly as the host hands them to a backend. */
const ASSISTANT_TOOLS = toolDefinitions().map(tool => tool.name);

async function connect(ctx: Ctx) {
  const server = createMcpServer(() => ctx, { assistant: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "0.0.1" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
  return { client, call };
}

test("it lists only the assistant's current tools, with the host's own names and schemas", async () => {
  const ctx = fakeCtx();
  const withEnv: Ctx = { ...ctx, env: { ...ctx.env, PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: TURN, PACER_ASSISTANT_URL: "http://127.0.0.1:4317" } };
  const { client } = await connect(withEnv);
  const listed = await client.listTools();
  expect(listed.tools.map(tool => tool.name).sort()).toEqual([...ASSISTANT_TOOLS].sort());
  // propose_action is one of them, and every schema is the host's, not a re-declared copy.
  expect(listed.tools.map(tool => tool.name)).toContain("propose_action");
  const snapshot = listed.tools.find(tool => tool.name === "snapshot")!;
  const expected = toolDefinitions().find(tool => tool.name === "snapshot")!;
  expect(snapshot.description).toBe(expected.description);
  expect(snapshot.inputSchema).toEqual(expected.parameters as typeof snapshot.inputSchema);
  // No task, dispatch, strategy or plugin tool of the planner's server is reachable.
  for (const name of ["delegate", "task_status", "budget_status", "strategy_save", "msg_send", "task_stop"])
    expect(listed.tools.map(tool => tool.name)).not.toContain(name);
  await client.close();
});

test("it forwards each call to assistant.tool on the turn the grant names", async () => {
  const base = fakeCtx();
  const live = issueAssistantGrant(base, { turnId: TURN, conversationId: "c-1", expiresAt: base.now + 3600 });
  const close = openAssistantTurnFor(TURN, {
    turnId: TURN, scope, read: async () => ({ snapshot: { counts: { open: 3 } } }),
    redactor: createRedactor([], base.home), cards: { task: () => null },
    state: { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: 6 } },
  });
  const server = startServer(() => base, { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false });
  try {
    const ctx: Ctx = { ...base, env: { ...base.env, PACER_ASSISTANT_GRANT: live, PACER_ASSISTANT_TURN: TURN, PACER_ASSISTANT_URL: `http://127.0.0.1:${server.port}` } };
    const { client, call } = await connect(ctx);
    const result = await call("snapshot");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ name: "snapshot", ok: true });
    expect(result.structuredContent.content).toStartWith('<data tool="snapshot">');
    // A tool the assistant's set does not hold never reaches the op.
    const unknown = await call("delegate", { goal: "g" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("Unknown tool delegate");
    await client.close();
    // The turn ends: the same call now fails instead of running as anyone else.
    close();
    const { client: after, call: afterCall } = await connect(ctx);
    const ended = await afterCall("snapshot");
    expect(ended.isError).toBe(true);
    expect(ended.content[0].text).toContain("has ended");
    await after.close();
  } finally { await server.stop(); }
});

test("without a live grant it registers nothing usable and every call errors", async () => {
  // An empty PACER_HOME: no token file exists and none is looked up.
  const home = mkdtempSync(join(tmpdir(), "mcp-assistant-"));
  const ctx = fakeCtx({ home, pacerHome: join(home, ".pacer") });
  expect(existsSync(ctx.pacerHome)).toBe(false);
  const { client, call } = await connect(ctx);
  expect(existsSync(ctx.pacerHome)).toBe(false);
  expect((await client.listTools()).tools).toEqual([]);
  for (const name of [...ASSISTANT_TOOLS, "delegate"]) {
    const result = await call(name);
    expect(result.isError, name).toBe(true);
    expect(result.content[0].text, name).toContain("no live grant");
  }
  await client.close();
  // A malformed grant or turn is no grant either.
  for (const env of [
    { PACER_ASSISTANT_GRANT: "pag_forged", PACER_ASSISTANT_TURN: TURN },
    { PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: "" },
    { PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: "turn/with/slash" },
    { PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: TURN, PACER_ASSISTANT_URL: "http://example.com" },
  ]) {
    const { client: other, call: otherCall } = await connect({ ...ctx, env: { ...ctx.env, ...env } });
    expect((await other.listTools()).tools, JSON.stringify(env)).toEqual([]);
    expect((await otherCall("snapshot")).isError).toBe(true);
    await other.close();
  }
});

/** The CLI's own stdio entry point, driven through a real child process. */
async function cliAssistant(env: Record<string, string | undefined>, argv: string[]) {
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(frame => JSON.stringify(frame)).join("\n") + "\n";
  return execProcess({
    argv: [process.execPath, "src/cli.ts", ...argv],
    cwd: process.cwd(),
    stdin: frames,
    env: { ...process.env, ...env },
    timeoutMs: 30_000,
  });
}

test("pacer mcp --assistant serves the assistant's tools from an empty PACER_HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-assistant-cli-"));
  const pacerHome = join(home, ".pacer");
  const result = await cliAssistant(
    { PACER_HOME: pacerHome, PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: TURN, PACER_ASSISTANT_URL: "http://127.0.0.1:4317" },
    ["mcp", "--assistant"],
  );
  expect(result.stderr, result.stderr).not.toContain("pacer:");
  expect(result.code).toBe(0);
  const replies = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const listed = replies.find(reply => reply.id === 2);
  expect(listed?.result?.tools?.map((tool: { name: string }) => tool.name).sort()).toEqual([...ASSISTANT_TOOLS].sort());
  // Nothing was written to the redirected home: no token file, no config.
  expect(existsSync(join(pacerHome, "token"))).toBe(false);
  // Without the grant the same command serves no tools at all.
  const bare = await cliAssistant({ PACER_HOME: pacerHome }, ["mcp", "--assistant"]);
  expect(bare.code).toBe(0);
  const bareReplies = bare.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(bareReplies.find(reply => reply.id === 2)?.result?.tools).toEqual([]);
}, 60_000);

test("an assistant grant runs no other pacer command", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-assistant-cli-"));
  const refused = await cliAssistant({ PACER_HOME: join(home, ".pacer"), PACER_ASSISTANT_GRANT: GRANT, PACER_ASSISTANT_TURN: TURN }, ["status"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("an assistant grant only allows the MCP server");
}, 60_000);
