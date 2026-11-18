import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { issueAssistantGrant, revokeAssistantGrants } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// Phase 1B §2: both credential gates accept `pag_` for POST /v3/ops/assistant.tool and nothing else.
// The same matrix runs against the public listener and behind the Rust front door's task auth.

const TURN = "turn-http000001";
const OTHER = "turn-http000002";
const TOKEN = `pag_${"ab".repeat(32)}`;

function fixture() {
  const base = fakeCtx();
  mkdirSync(base.pacerHome, { recursive: true });
  writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const start = base.now;
  let now = start;
  // A grant that is live for the whole run, one that expired before it, and one revoked at once.
  const live = issueAssistantGrant(base, { turnId: TURN, conversationId: "c-1", expiresAt: start + 3600 });
  const expired = issueAssistantGrant({ ...base, now: start - 100 }, { turnId: OTHER, conversationId: "c-1", expiresAt: start - 50 });
  const revoked = issueAssistantGrant(base, { turnId: "turn-http000003", conversationId: "c-1", expiresAt: start + 3600 });
  revokeAssistantGrants(base, "turn-http000003");
  const getCtx = (): Ctx => ({ ...base, now });
  const server = startServer(getCtx, { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false });
  const base1 = `http://127.0.0.1:${server.port}`;
  const call = async (path: string, bearer: string, init: RequestInit = {}) => {
    const response = await fetch(`${base1}${path}`, {
      ...init,
      method: init.method ?? "POST",
      headers: { authorization: `Bearer ${bearer}`, host: `127.0.0.1:${server.port}`, ...(init.headers ?? {}) },
      body: JSON.stringify({ turnId: TURN, name: "snapshot", params: {} }),
    });
    return { status: response.status, text: await response.text() };
  };
  return { server, call, live, expired, revoked };
}

/** The route is the gate's business; what answers it is the op's. */
const RANKED = (status: number) => (status === 403 ? "refused" : "reached the core");

test("the public gate accepts pag_ only for POST /v3/ops/assistant.tool", async () => {
  const f = fixture();
  try {
    const paths = [
      "/v3/ops/assistant.status",
      "/v3/ops/assistant.ask",
      "/v3/ops/assistant.turn",
      "/v3/ops/task.get",
      "/v3/ops/snapshot.get",
      "/v3/ops/dispatch.child",
      "/v3/snapshot",
      "/v3/hello",
      "/v3/assistant/turns/turn-http000001/stream",
      "/v2/ops/assistant.tool",
    ];
    for (const path of paths) expect((await f.call(path, f.live)).status, path).toBe(403);
    // GET and unauthenticated shapes never reach the op either.
    const get = await fetch(`http://127.0.0.1:${f.server.port}/v3/ops/assistant.tool`, {
      headers: { authorization: `Bearer ${f.live}`, host: `127.0.0.1:${f.server.port}` },
    });
    expect(get.status).toBe(403);
    const wrongMethod = await f.call("/v3/ops/assistant.tool", f.live, { method: "DELETE" });
    expect(wrongMethod.status).toBe(403);
    // The one route the gate opens is not refused by it.
    expect(RANKED((await f.call("/v3/ops/assistant.tool", f.live)).status)).toBe("reached the core");
  } finally { await f.server.stop(); }
});

test("the public gate refuses an unknown, expired or revoked pag_ and never the operator", async () => {
  const f = fixture();
  try {
    // Well-formed but not live: refused at the gate, never passed on as anyone.
    for (const bearer of [f.expired, f.revoked, TOKEN, `pag_${"0".repeat(64)}`]) {
      const response = await f.call("/v3/ops/assistant.tool", bearer);
      expect(response.status, bearer.slice(0, 12)).toBe(403);
      expect(response.text).toBe("forbidden\n");
    }
    // A work grant is still a work grant here, and the core refuses it for assistant.*.
    expect((await f.call("/v3/ops/assistant.tool", `pwg_${"ab".repeat(32)}`)).status).toBe(403);
    // A token that is not even the right shape is never a credential at all.
    for (const bearer of [`pag_${"AB".repeat(32)}`, `pag_${"ab".repeat(31)}`, "pag_"]) {
      const response = await f.call("/v3/ops/assistant.tool", bearer);
      expect([401, 403], bearer).toContain(response.status);
    }
  } finally { await f.server.stop(); }
});

test("behind the front door, the task header forwards pag_ only to assistant.tool", async () => {
  const base = fakeCtx();
  const start = base.now;
  const live = issueAssistantGrant(base, { turnId: TURN, conversationId: "c-1", expiresAt: start + 3600 });
  const revoked = issueAssistantGrant(base, { turnId: "turn-http000004", conversationId: "c-1", expiresAt: start + 3600 });
  revokeAssistantGrants(base, "turn-http000004");
  const server = startServer(() => ({ ...base, now: start }), { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false, internal: { token: "i".repeat(64) } });
  const port = server.port;
  const forwarded = (path: string, grant: string, method = "POST") => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${"i".repeat(64)}`,
      "x-pacer-auth": "task",
      "x-pacer-work-grant": `Bearer ${grant}`,
      host: `127.0.0.1:${port}`,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify({ turnId: TURN, name: "snapshot", params: {} }) }),
  });
  try {
    for (const path of [
      "/v3/ops/assistant.status",
      "/v3/ops/assistant.ask",
      "/v3/ops/task.get",
      "/v3/ops/snapshot.get",
      "/v3/snapshot",
      "/v2/ops/assistant.tool",
    ]) expect((await forwarded(path, live)).status, path).toBe(403);
    expect((await forwarded("/v3/ops/assistant.tool", live, "GET")).status).toBe(403);
    expect(RANKED((await forwarded("/v3/ops/assistant.tool", live)).status)).toBe("reached the core");
    for (const grant of [revoked, TOKEN, `pag_${"cd".repeat(32)}`])
      expect((await forwarded("/v3/ops/assistant.tool", grant)).status, grant.slice(0, 12)).toBe(403);
    expect((await forwarded("/v3/ops/assistant.tool", `pwg_${"ab".repeat(32)}`)).status).toBe(403);
  } finally { await server.stop(); }
});
