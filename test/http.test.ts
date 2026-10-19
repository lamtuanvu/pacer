import { afterEach, expect, test } from "bun:test";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureToken, startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

let stop: (() => void) | undefined;
afterEach(() => stop?.());

async function serve() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const s = startServer(() => ctx, { port: 0, sseIntervalMs: 50 });
  stop = s.stop;
  return { ctx, ...s, url: `http://127.0.0.1:${s.port}` };
}

test("ensureToken creates a 0600 token once and reuses it", () => {
  const ctx = fakeCtx();
  const a = ensureToken(ctx);
  expect(a).toMatch(/^[0-9a-f]{48}$/);
  expect(ensureToken(ctx)).toBe(a);
  expect(statSync(join(ctx.pacerHome, "token")).mode & 0o777).toBe(0o600);
});

test("requests without the bearer token are rejected", async () => {
  const { url } = await serve();
  expect((await fetch(`${url}/state`)).status).toBe(401);
  expect((await fetch(`${url}/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
});

test("removed routes return 404; unknown paths 404; non-GET 405", async () => {
  const { url, token } = await serve();
  const h = { authorization: `Bearer ${token}` };
  const r = await fetch(`${url}/state`, { headers: h });
  expect(r.status).toBe(404);
  for(const path of ["/console/open","/console/forget"])expect((await fetch(url+path,{method:"POST",headers:h})).status).toBe(404);
  expect((await fetch(`${url}/nope`, { headers: h })).status).toBe(404);
  expect((await fetch(`${url}/state`, { method: "POST", headers: h })).status).toBe(404);
});

test("health identifies the serving process without authentication",async()=>{
  const { url } = await serve();
  const r = await fetch(url + "/health");
  expect(r.headers.get("X-Pacer")).toBe("1");
  expect(await r.json()).toMatchObject({ ok: true, pid: process.pid, backendLagS: expect.any(Number) });
});
