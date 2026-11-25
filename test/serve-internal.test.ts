import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";
import { executorEnv } from "../src/exec/process";
import { keychainStubPath } from "./keychain-stub";

test("internal mode trusts only the internal token and keeps the bearer/cookie distinction", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const s = startServer(() => ctx, { port: 0, pumpMs: 0, internal: { token: "i".repeat(64) } });
  try {
    const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
    const host = { host: `127.0.0.1:${s.port}` };
    expect((await fetch(url("/v3/hello"), { headers: { ...host, authorization: `Bearer ${s.token}` } })).status).toBe(401);
    for (const path of ["/health", "/app/auth", "/_internal/plugins"]) {
      expect((await fetch(url(path))).status).toBe(401);
    }
    const cookie = await fetch(url("/v3/hello"), { headers: {
      ...host, authorization: `Bearer ${"i".repeat(64)}`, "x-pacer-auth": "cookie",
      origin: "https://foreign.example", "sec-fetch-site": "cross-site",
    } });
    expect(cookie.status).toBe(200);
    const ok = await fetch(url("/v3/hello"), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}`, "x-pacer-auth": "bearer" } });
    expect(ok.status).toBe(200);
    const health = await fetch(url("/health"), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, pid: process.pid });
    const privateHeaders = { ...host, authorization: `Bearer ${"i".repeat(64)}`, "content-type": "application/json" };
    for (const op of [undefined, "notifications.set", "strategy.use", "plugin.doctor"]) {
      const reply = await fetch(url("/_internal/native-config-finish"), {method: "POST", headers: privateHeaders, body: JSON.stringify({op})});
      expect(reply.status).toBe(404);
      expect(await reply.json()).toMatchObject({error: {code: "unknown_op"}});
    }
    for (const auth of ["cookie", "task"]) {
      const reply = await fetch(url("/_internal/native-config-finish"), {method: "POST", headers: {...privateHeaders, "x-pacer-auth": auth}, body: JSON.stringify({op: "runner.set"})});
      expect(reply.status).toBe(403);
    }
    // An unknown private POST follows the reference server's method refusal.
    expect((await fetch(url("/_internal/config-sync"), {method: "POST", headers: privateHeaders})).status).toBe(405);
    // The app error page endpoint is gone: pages render through the native front door now.
    expect((await fetch(url("/_internal/app-page?status=1"), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } })).status).toBe(404);
    const spa = await fetch(url("/app/"), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } });
    expect(spa.status).toBe(200);
  } finally { s.stop(); }
});

for (const env of [{}, { PACER_INTERNAL_TOKEN: "i".repeat(64) }]) {
  test(`internal CLI refuses to start without its secrets frame (${Object.keys(env).join() || "no token"})`, async () => {
    const ctx = fakeCtx({ env });
    const result = await main(["serve", "--internal", "--token", "i".repeat(64)], ctx);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("secrets frame on stdin (PACER_CORE_SECRETS=stdin/1)");
    expect(ctx.env).not.toHaveProperty("PACER_INTERNAL_TOKEN");
  });
}

test("executors never inherit any of Core's secrets", () => {
  const env = executorEnv({ PACER_INTERNAL_TOKEN: "i".repeat(64), PACER_NATIVE_CONFIG_SYNC_KEY: "k".repeat(64), PATH: "/bin" }, {});
  expect(env).not.toHaveProperty("PACER_INTERNAL_TOKEN");
  expect(env).not.toHaveProperty("PACER_NATIVE_CONFIG_SYNC_KEY");
});

test("executors never inherit the native process owner socket or its credential", () => {
  const env = executorEnv({ PACER_HOST_SOCKET: "/tmp/pacer/run/host.sock", PACER_HOST_SOCKET_KEY: "ab".repeat(32), PATH: "/bin" }, {}, "t-1");
  expect(env).not.toHaveProperty("PACER_HOST_SOCKET");
  expect(env).not.toHaveProperty("PACER_HOST_SOCKET_KEY");
  expect(env.PATH).toBe("/bin");
});

test("internal core exits when its supervising stdin pipe closes", async () => {
  const ctx = fakeCtx();
  const pluginDir = join(ctx.pacerHome, "plugins", "fx-stubborn");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  codex: {}\nplugins:\n  installed:\n    fx-stubborn:\n      version: 1.0.0\n      capabilities: []\n");
  writeFileSync(join(pluginDir, "pacer-plugin.json"), JSON.stringify({
    id: "fx-stubborn", version: "1.0.0", publisher: "test", host: "^1", entry: "main.ts", capabilities: [],
  }));
  writeFileSync(join(pluginDir, "main.ts"), `#!/usr/bin/env bun
import { createInterface } from "node:readline";
process.on("SIGTERM", () => {});
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  const result = request.method === "plugin.hello"
    ? { id: "fx-stubborn", version: "1.0.0", protocol: "1.0.0", contributes: ["diagnostic"] }
    : { ok: true, uptimeS: 0 };
  console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
}
`, { mode: 0o755 });
  let pluginPid: number | undefined;
  const child = Bun.spawn([process.execPath, "src/cli.ts", "serve", "--internal"], {
    env: { ...process.env, HOME: ctx.home, PACER_HOME: ctx.pacerHome, PATH: keychainStubPath(ctx.home),
      PACER_CORE_SECRETS: "stdin/1", PACER_INTERNAL_PARENT_PIPE: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const body = JSON.stringify({ internalToken: "f".repeat(64) });
  child.stdin.write(`pacer-core-secrets/1 ${body.length}\n${body}`);
  child.stdin.flush();
  try {
    const reader = child.stdout.getReader();
    const announced = await reader.read();
    expect(new TextDecoder().decode(announced.value)).toContain('"internal"');
    reader.releaseLock();
    const port = JSON.parse(new TextDecoder().decode(announced.value)).internal.port;
    const doctor = await fetch(`http://127.0.0.1:${port}/v3/ops/plugin.doctor`, {
      method: "POST", headers: { authorization: `Bearer ${"f".repeat(64)}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "fx-stubborn" }),
    });
    expect(doctor.status).toBe(200);
    const { result: body } = await doctor.json() as { result: { reports: { ok: boolean; pid: number }[] } };
    expect(body.reports[0]?.ok).toBe(true);
    pluginPid = body.reports[0]!.pid;
    child.stdin.end();
    const exited = await Promise.race([child.exited, Bun.sleep(10000).then(() => "still running")]);
    expect(exited).toBe(0);
    let pluginAlive = true;
    try { process.kill(pluginPid, 0); } catch { pluginAlive = false; }
    expect(pluginAlive).toBe(false);
  } finally {
    if (pluginPid) { try { process.kill(pluginPid, "SIGKILL"); } catch { /* already stopped */ } }
    child.kill();
    await child.exited;
  }
}, 30000);
