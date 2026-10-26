import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

test("health answers while the service thread is synchronously blocked", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/serve-health-block.ts")], { stdout: "pipe", stderr: "pipe" });
  try {
    const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("blocking\n")) {
      const part = await lines.read();
      if (part.done) throw Error(`service exited: ${await new Response(child.stderr).text()}`);
      text += part.value;
    }
    const { port } = JSON.parse(text.split("\n")[0]!);
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pid: child.pid, backendLagS: expect.any(Number) });
    expect(response.headers.get("x-pacer")).toBe("1");
    expect(performance.now() - start).toBeLessThan(500);
    const bad = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Host: "evil.test" } });
    expect(bad.status).toBe(421);
  } finally { child.kill("SIGKILL"); await child.exited; }
}, 10000);

for (const delayed of [false, true]) {
  test(`serve --help exits without a listener despite ${delayed ? "delayed" : "normal"} module availability`, async () => {
    const home = mkdtempSync(join(tmpdir(), "pacer-serve-help-"));
    const pacerHome = join(home, "state");
    const guard = join(import.meta.dir, "fixtures/serve-help-guard.ts");
    const child = Bun.spawn([process.execPath, "--preload", guard, "src/cli.ts", "serve", "--help"], {
      env: { HOME: home, PACER_HOME: pacerHome, PACER_NO_UPDATE_CHECK: "1", PACER_TEST_DELAY_IMPORT: delayed ? "1" : "0", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" },
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stdout).toContain("serve [--port");
      expect(stderr).toBe("serve-help-listeners:[]\n");
      expect(existsSync(pacerHome)).toBe(false);
    } finally { child.kill("SIGKILL"); await child.exited; rmSync(home, { recursive: true, force: true }); }
  });
}

test("serve-help guard rejects the real service before any listener can bind", async () => {
  const home = mkdtempSync(join(tmpdir(), "pacer-serve-help-control-"));
  const guard = join(import.meta.dir, "fixtures/serve-help-guard.ts");
  const child = Bun.spawn([process.execPath, "--preload", guard, "src/cli.ts", "serve", "--port", "0"], {
    env: { HOME: home, PACER_HOME: join(home, "state"), PACER_NO_UPDATE_CHECK: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "" },
    stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("serve-help fixture refused Bun.serve");
    expect(stderr).toContain('serve-help-listeners:["Bun.serve"]');
  } finally { child.kill("SIGKILL"); await child.exited; rmSync(home, { recursive: true, force: true }); }
});

test("health reports a stale heartbeat while the backend remains blocked, then recovers", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/serve-health-block.ts"), "stale"], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("blocking\n")) {
      const part = await reader.read();
      if (part.done) throw Error(await new Response(child.stderr).text());
      text += part.value;
    }
    const { port } = JSON.parse(text.split("\n")[0]!);
    const health = () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    await Bun.sleep(700);
    const stale = await health();
    expect(stale.status).toBe(503);
    const body = await stale.json();
    expect(body).toMatchObject({ ok: false, pid: child.pid });
    expect(body.backendLagS).toBeGreaterThan(0.6);
    while (!text.includes("unblocked\n")) {
      const part = await reader.read();
      if (part.done) throw Error("fixture exited before recovery");
      text += part.value;
    }
    // The overdue interval writes a fresh heartbeat after the blocked turn ends.
    await Bun.sleep(20);
    expect((await health()).status).toBe(200);
  } finally { child.kill("SIGKILL"); await child.exited; }
}, 10000);
