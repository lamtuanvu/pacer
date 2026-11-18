import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRedactor } from "../src/assistant/redact";
import { openAssistantTurnFor } from "../src/assistant/turn-tools";
import type { AssistantScope } from "../src/assistant/types";
import { issueAssistantGrant, revokeAssistantGrants } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";
import type { Ctx } from "../src/types";
import { fakeCtx } from "./helpers";

// Phase 1B §2: both credential gates accept `pag_` for POST /v3/ops/assistant.tool and nothing else.
// The same matrix runs against the public listener and behind the Rust front door's task auth.

const TURN = "turn-http000001";
const OTHER = "turn-http000002";
const REVOKED = "turn-http000003";
const TOKEN = `pag_${"ab".repeat(32)}`;
const scope: AssistantScope = { kind: "dispatch", days: 7 };

/** One turn's tool context, so the one route the gate opens has an answer behind it. */
const openTurn = (c: Ctx, turnId: string) => openAssistantTurnFor(turnId, {
  turnId, scope, read: async () => ({ snapshot: { counts: { open: 3 } } }),
  redactor: createRedactor([], c.home), cards: { task: () => null },
  state: { cards: [], notes: [], toolLog: [], seenTasks: new Set(), rounds: { used: 0, max: 6 } },
});

function fixture() {
  const base = fakeCtx();
  mkdirSync(base.pacerHome, { recursive: true });
  writeFileSync(join(base.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const start = base.now;
  // A grant live for the whole run, one that expired before it, and one revoked at once.
  const live = issueAssistantGrant(base, { turnId: TURN, conversationId: "c-1", expiresAt: start + 3600 });
  const expired = issueAssistantGrant({ ...base, now: start - 100 }, { turnId: OTHER, conversationId: "c-1", expiresAt: start - 50 });
  const revoked = issueAssistantGrant(base, { turnId: REVOKED, conversationId: "c-1", expiresAt: start + 3600 });
  revokeAssistantGrants(base, REVOKED);
  const close = openTurn(base, TURN);
  const server = startServer(() => ({ ...base, now: start }), { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false });
  const port = server.port;
  const call = async (path: string, bearer: string, init: RequestInit = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      method: init.method ?? "POST",
      headers: { authorization: `Bearer ${bearer}`, host: `127.0.0.1:${port}` },
      body: JSON.stringify({ turnId: TURN, name: "snapshot", params: {} }),
    });
    return { status: response.status, text: await response.text() };
  };
  return { server, call, live, expired, revoked, close };
}

test("the public gate accepts pag_ only for POST /v3/ops/assistant.tool", async () => {
  const f = fixture();
  try {
    for (const path of [
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
    ]) expect((await f.call(path, f.live)).status, path).toBe(403);
    // Neither method nor a wrong route is a way around it.
    expect((await f.call("/v3/ops/assistant.tool", f.live, { method: "DELETE" })).status).toBe(403);
    const get = await fetch(`http://127.0.0.1:${f.server.port}/v3/ops/assistant.tool`, {
      headers: { authorization: `Bearer ${f.live}` },
    });
    expect(get.status).toBe(403);
    // The one route the gate opens reaches the core and runs the turn's own tool pipeline.
    const allowed = await f.call("/v3/ops/assistant.tool", f.live);
    expect(allowed.status).toBe(200);
    const result = JSON.parse(allowed.text).result as { name: string; content: string; ok: boolean };
    expect(result).toMatchObject({ name: "snapshot", ok: true });
    expect(result.content).toStartWith('<data tool="snapshot">');
  } finally { f.close(); await f.server.stop(); }
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
    // A valid grant with no live turn behind it is refused by the op, not treated as the operator.
    f.close();
    const ended = await f.call("/v3/ops/assistant.tool", f.live);
    expect(ended.status).toBe(403);
    expect(JSON.parse(ended.text).error).toMatchObject({ code: "not_allowed", message: expect.stringContaining("has ended") });
  } finally { await f.server.stop(); }
});

test("behind the front door, the task header forwards pag_ only to assistant.tool", async () => {
  const base = fakeCtx();
  const start = base.now;
  const turn = "turn-http000011";
  const live = issueAssistantGrant(base, { turnId: turn, conversationId: "c-1", expiresAt: start + 3600 });
  const revoked = issueAssistantGrant(base, { turnId: "turn-http000012", conversationId: "c-1", expiresAt: start + 3600 });
  revokeAssistantGrants(base, "turn-http000012");
  const close = openTurn(base, turn);
  const server = startServer(() => ({ ...base, now: start }), { port: 0, listener: false, pumpMs: 0, backgroundWorker: false, supervisionWorker: false, internal: { token: "i".repeat(64) } });
  const port = server.port;
  const forwarded = (path: string, grant: string, method = "POST", turnId = turn) => fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${"i".repeat(64)}`,
      "x-pacer-auth": "task",
      "x-pacer-work-grant": `Bearer ${grant}`,
      host: `127.0.0.1:${port}`,
    },
    ...(method === "GET" ? {} : { body: JSON.stringify({ turnId, name: "snapshot", params: {} }) }),
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
    for (const grant of [revoked, TOKEN, `pag_${"cd".repeat(32)}`])
      expect((await forwarded("/v3/ops/assistant.tool", grant)).status, grant.slice(0, 12)).toBe(403);
    // Another turn's id is refused by the core, and a work grant is refused for assistant.*.
    expect((await forwarded("/v3/ops/assistant.tool", live, "POST", "turn-http000013")).status).toBe(403);
    expect((await forwarded("/v3/ops/assistant.tool", `pwg_${"ab".repeat(32)}`)).status).toBe(403);
    const allowed = await forwarded("/v3/ops/assistant.tool", live);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ result: { name: "snapshot", ok: true } });
  } finally { close(); await server.stop(); }
});
