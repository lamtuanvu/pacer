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

test("/state returns the status JSON; unknown paths 404; non-GET 405", async () => {
  const { url, token } = await serve();
  const h = { authorization: `Bearer ${token}` };
  const r = await fetch(`${url}/state`, { headers: h });
  expect(r.status).toBe(200);
  expect((await r.json()).planner).toBe("claude-code");
  expect((await fetch(`${url}/nope`, { headers: h })).status).toBe(404);
  expect((await fetch(`${url}/state`, { method: "POST", headers: h })).status).toBe(405);
});

test("/events streams budget envelopes", async () => {
  const { url, token } = await serve();
  const r = await fetch(`${url}/events`, { headers: { authorization: `Bearer ${token}` } });
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  const reader = r.body!.getReader();
  const { value } = await reader.read();
  const line = new TextDecoder().decode(value);
  expect(line.startsWith("data: ")).toBe(true);
  const msg = JSON.parse(line.slice(6).trim());
  expect(msg).toMatchObject({ v: 1, type: "budget" });
  expect(msg.data.planner).toBe("claude-code");
  await reader.cancel();
});

test("/events sends an alert when status fails and keeps streaming", async () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const s = startServer(() => ctx, { port: 0, sseIntervalMs: 50 });
  stop = s.stop;
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: [unclosed");

  const r = await fetch(`http://127.0.0.1:${s.port}/events`, {
    headers: { authorization: `Bearer ${s.token}` },
  });
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const firstMsg = JSON.parse(decoder.decode(first.value).slice(6).trim());
  expect(firstMsg).toMatchObject({ v: 1, type: "alert" });
  expect(firstMsg.data.error).toContain("YAML");

  const second = await reader.read();
  const secondMsg = JSON.parse(decoder.decode(second.value).slice(6).trim());
  expect(secondMsg).toMatchObject({ v: 1, type: "alert" });
  expect(secondMsg.data.error).toContain("YAML");
  await reader.cancel();
});
