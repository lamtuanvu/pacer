import { expect, test } from "bun:test";
import { join } from "node:path";

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

test("serve --help prints usage and exits without opening a listener", async () => {
  const child = Bun.spawn([process.execPath, "src/cli.ts", "serve", "--help"], { stdout: "pipe", stderr: "pipe" });
  try {
    const code = await Promise.race([child.exited, Bun.sleep(1000).then(() => "timeout")]);
    expect(code).toBe(0);
    expect(await new Response(child.stdout).text()).toContain("serve [--port");
  } finally { child.kill("SIGKILL"); await child.exited; }
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
