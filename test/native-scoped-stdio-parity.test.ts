// API-5: behind the Rust front door, `api --stdio` under an enforcement (`pet_`) or assistant
// (`pag_`) identity leaves every operation to the core, and the legitimate uses of both identities
// still work.
import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRedactor } from "../src/assistant/redact";
import { openAssistantTurnFor } from "../src/assistant/turn-tools";
import { issueEnforcementToken } from "../src/dispatch/enforcement-token";
import { dispatchDatabase } from "../src/dispatch/store";
import { issueAssistantGrant, registerWork } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { childEnv, fakeServiceManager } from "./child-env";
import { fakeCtx, gitRepo, tmpDir } from "./helpers";
import { keychainStubPath } from "./keychain-stub";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, resolve(import.meta.dir, "../src/cli.ts")]);

function frontEnv(home: string) {
  return {
    ...childEnv(home),
    PATH: `${fakeServiceManager(home)}:${keychainStubPath(home)}`,
    PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1",
  };
}

test.skipIf(!front)("a live enforcement identity records its denial over stdio and nothing else", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const task = createTask(ctx, { brief: { goal: "work", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, task.id, { allowDelegation: false });
  updateTask(ctx, task.id, t => { t.state = "running"; });
  const token = issueEnforcementToken(ctx, task.id, 1);
  const home = mkdtempSync(join(tmpDir(), "pet-"));
  cpSync(ctx.home, home, { recursive: true });
  const repo = gitRepo();
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } },
    { jsonrpc: "2.0", id: 2, method: "dispatch.enforcement.denied", params: { agent: "claude-code" } },
    { jsonrpc: "2.0", id: 3, method: "repo.add", params: { path: repo } },
    { jsonrpc: "2.0", id: 4, method: "repo.list", params: {} },
  ];
  const child = Bun.spawn([front!, "api", "--stdio"], {
    env: { ...frontEnv(home), PACER_ROLE: "executor", PACER_ENFORCEMENT_TOKEN: token },
    stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  await child.stdin.write(requests.map(request => JSON.stringify(request)).join("\n") + "\n");
  await child.stdin.end();
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
  expect(stderr.split("\n").filter(line => line.startsWith("native "))).toEqual([]);
  const replies = new Map(stdout.trim().split("\n").map(line => JSON.parse(line)).map(reply => [reply.id, reply]));
  expect(replies.get(2).result).toEqual({ recorded: true });
  expect(replies.get(3).error.data.code).toBe("not_allowed");
  expect(replies.get(4).error.data.code).toBe("not_allowed");
  const events = dispatchDatabase({ ...ctx, home, pacerHome: join(home, ".pacer") })
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'native-child.denied'").get();
  expect(events?.n).toBe(1);
});

test.skipIf(!front)("the assistant's MCP server started through the front door still runs its tool", async () => {
  const ctx = fakeCtx();
  const turnId = "turn-front00001";
  const grant = issueAssistantGrant(ctx, { turnId, conversationId: "c-1", expiresAt: ctx.now + 3600 });
  const close = openAssistantTurnFor(turnId, {
    turnId, scope: { kind: "dispatch", days: 7 }, read: async () => ({ snapshot: { counts: { open: 3 } } }),
    redactor: createRedactor([], ctx.home), cards: { task: () => null },
    state: { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: 6 } },
  });
  const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false });
  const home = mkdtempSync(join(tmpDir(), "pag-"));
  const client = new Client({ name: "test", version: "0.0.1" });
  try {
    await client.connect(new StdioClientTransport({
      command: front!, args: ["mcp", "--assistant"], stderr: "pipe",
      env: {
        ...frontEnv(home) as Record<string, string>, PACER_ASSISTANT_GRANT: grant, PACER_ASSISTANT_TURN: turnId,
        PACER_ASSISTANT_URL: `http://127.0.0.1:${server.port}`,
      },
    }));
    const result = await client.callTool({ name: "snapshot", arguments: {} });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ name: "snapshot", ok: true });
  } finally {
    await client.close();
    close();
    await server.stop();
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
