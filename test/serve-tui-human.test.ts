import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { clearSessions, createSession } from "../src/serve/app-auth";
import { dashboardClient } from "../src/dashboard/client";
import { fakeCtx } from "./helpers";

function serve() {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}, codex: {}}\n");
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  return { ctx, server, origin: `http://127.0.0.1:${server.port}` };
}
async function withTTY<T>(tty: boolean, f: () => Promise<T>): Promise<T> {
  const prior = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: tty, configurable: true });
  try { return await f(); } finally { if (prior) Object.defineProperty(process.stdin, "isTTY", prior); else delete (process.stdin as { isTTY?: boolean }).isTTY; }
}

test("a bearer request is the human only with a valid app session; a bearer alone stays external:local", async () => {
  const { ctx, server, origin } = serve();
  const inbox = async (headers: Record<string, string>) => {
    const response = await fetch(`${origin}/v3/ops/msg.inbox`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${server.token}`, ...headers } });
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: { participant: string } }).result.participant;
  };
  try {
    expect(await inbox({})).toBe("external:local");
    expect(await inbox({ "x-pacer-session": "0".repeat(64) })).toBe("external:local");
    expect(await inbox({ "x-pacer-session": "not a session" })).toBe("external:local");
    const session = createSession(ctx);
    expect(await inbox({ "x-pacer-session": session })).toBe("human");
    // A session header never stands in for the bearer.
    const unauthenticated = await fetch(`${origin}/v3/ops/msg.inbox`, { method: "POST", body: "{}", headers: { "x-pacer-session": session } });
    expect(unauthenticated.status).toBe(401);
    clearSessions(ctx);
    expect(await inbox({ "x-pacer-session": session })).toBe("external:local");
  } finally { server.stop(); }
});

test("the TUI over the service connection is the human from an interactive terminal, and only there", async () => {
  const { ctx, server } = serve();
  const inbox = async (env: Record<string, string>) => {
    const client = await dashboardClient({ ...ctx, env: { ...ctx.env, PACER_PORT: String(server.port), ...env } });
    try {
      expect(client.kind).toBe("http");
      return (await client.call<{ participant: string }>("msg.inbox", {})).participant;
    } finally { client.close(); }
  };
  try {
    expect(await withTTY(true, () => inbox({}))).toBe("human");
    expect(await withTTY(false, () => inbox({}))).toBe("external:local");
    expect(await withTTY(true, () => inbox({ CLAUDECODE: "1" }))).toBe("external:local");
  } finally { server.stop(); }
});
