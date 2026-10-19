import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "../src/serve/http";
import { clearSessions, createSession } from "../src/serve/app-auth";
import { fakeCtx } from "./helpers";

test("cached snapshots recheck bearer, cookies, revocation and cross-site restrictions", async () => {
  const ctx = fakeCtx({ which: () => null });
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const get = (headers: HeadersInit = {}) => fetch(origin + "/v3/snapshot", { headers });
  try {
    const warm = await get({ Authorization: `Bearer ${server.token}` });
    expect(warm.status).toBe(200); await warm.text();
    const cookie = `pacer_session=${createSession(ctx)}`;
    for (const headers of [{}, { Authorization: "Bearer wrong" }, { Cookie: "pacer_session=wrong" }] as Record<string, string>[]) {
      expect((await get(headers)).status).toBe(401);
    }
    expect((await get({ Cookie: cookie })).status).toBe(200);
    expect((await get({ Cookie: cookie, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    clearSessions(ctx);
    expect((await get({ Cookie: cookie })).status).toBe(401);
    expect((await get({ Authorization: `Bearer ${server.token}` })).status).toBe(200);
  } finally { server.stop(); }
});

test("cached routing status preserves cookie write guards and body validation", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  const origin = `http://127.0.0.1:${server.port}`;
  const post = (body = "{}", headers: Record<string, string> = { Authorization: `Bearer ${server.token}` }) =>
    fetch(origin + "/v3/ops/routing.status", { method: "POST", body, headers });
  try {
    await Bun.sleep(100);
    expect((await post()).status).toBe(200);
    const cookie = `pacer_session=${createSession(ctx)}`;
    expect((await post("{}", { Cookie: cookie })).status).toBe(403);
    expect((await post("{}", { Cookie: cookie, Origin: "http://evil.test", "X-Pacer-Client": "app" })).status).toBe(403);
    expect((await post("{}", { Cookie: cookie, Origin: origin, "X-Pacer-Client": "app" })).status).toBe(200);
    // The backend treats null as empty parameters, as callOp does.
    expect((await post("null")).status).toBe(200);
    expect((await post("[]")).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    const large = await post(JSON.stringify({ data: "x".repeat(256 * 1024) }));
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ error: { code: "too_large" } });
  } finally { server.stop(); }
});
