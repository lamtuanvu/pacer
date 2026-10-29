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
    for (const path of ["/health", "/app/auth", "/_internal/app-page?status=401"]) {
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
    const page = await fetch(url("/_internal/app-page?status=401&message=Session%20ended."), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Session ended.");
    for (const status of ["1", "99999", "abc"]) {
      const odd = await fetch(url(`/_internal/app-page?status=${status}&message=x`), { headers: { ...host, authorization: `Bearer ${"i".repeat(64)}` } });
      expect(odd.status).toBe(500);
      expect(await odd.text()).not.toContain("at ");
    }
  } finally { s.stop(); }
});

for (const token of [undefined, "i".repeat(31)]) {
  test(`internal CLI rejects ${token ? "short" : "missing"} environment token`, async () => {
    const ctx = fakeCtx({ env: token ? { PACER_INTERNAL_TOKEN: token } : {} });
    const result = await main(["serve", "--internal", "--token", "i".repeat(64)], ctx);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("PACER_INTERNAL_TOKEN");
    expect(result.err).toContain("32");
  });
}

test("executors never inherit the internal credential", () => {
  expect(executorEnv({ PACER_INTERNAL_TOKEN: "i".repeat(64), PATH: "/bin" }, {}).PACER_INTERNAL_TOKEN).toBeUndefined();
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
      PACER_INTERNAL_TOKEN: "i".repeat(64), PACER_INTERNAL_PARENT_PIPE: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const announced = await reader.read();
    expect(new TextDecoder().decode(announced.value)).toContain('"internal"');
    reader.releaseLock();
    const port = JSON.parse(new TextDecoder().decode(announced.value)).internal.port;
    const doctor = await fetch(`http://127.0.0.1:${port}/v3/ops/plugin.doctor`, {
      method: "POST", headers: { authorization: `Bearer ${"i".repeat(64)}`, "content-type": "application/json" },
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
