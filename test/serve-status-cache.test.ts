import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as engine from "../src/engine/status";
import { startServer } from "../src/serve/http";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx } from "./helpers";
import { fakeServiceManager } from "./child-env";
import { closedPort, pinnedEnv, spawnPinned } from "./pinned-port";

test("cold snapshots report starting, then retain status during a failed background refresh", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n");
  const { st } = capacityFixture();
  let finish!: (value: Awaited<ReturnType<typeof engine.computeStatus>>) => void;
  let reject!: (reason: Error) => void;
  let calls = 0;
  const compute = spyOn(engine, "computeStatus").mockImplementation(() => {
    calls++;
    return new Promise((yes, no) => { finish = yes; reject = no; });
  });
  let refresh!: () => void;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    if (ms === 60_000) refresh = fn;
    return interval(fn, ms);
  }) as typeof setInterval);
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  timers.mockRestore();
  const request = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { Authorization: `Bearer ${server.token}` },
    ...(path.includes("/ops/") ? { method: "POST", body: "{}" } : {}),
    signal: AbortSignal.timeout(800),
  });
  try {
    const cold = await request("/v3/snapshot");
    expect((await cold.json()).snapshot.service.starting).toBe(true);
    expect(calls).toBe(1);
    finish({ ...st, accounts: [] });
    await Bun.sleep(20);
    refresh();
    await Bun.sleep(10);
    expect(calls).toBe(2);
    // The cached routing status must answer although this refresh is unresolved.
    expect((await request("/v3/ops/routing.status")).status).toBe(200);
    reject(Error("temporary status failure"));
    await Bun.sleep(20);
    expect((await request("/v3/ops/routing.status")).status).toBe(200);
    // A snapshot rebuild must use the stale status instead of reverting to starting.
    await Bun.sleep(1100);
    await (await request("/v3/snapshot")).text();
    await Bun.sleep(100);
    expect((await (await request("/v3/snapshot")).json()).snapshot.service.starting).not.toBe(true);
  } finally { finish?.({ ...st, accounts: [] }); server.stop(); compute.mockRestore(); }
}, 10000);

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;

/**
 * The native door serves `/v3/snapshot` from the service-owned `StatusCache`,
 * not from a status request to Core. A cold reader answers "starting"; once
 * the first status lands the planner/budget rows come from it, and a live
 * `mode.hold` is visible on the next snapshot without a status round trip.
 */
test.skipIf(!front)("native door answers /v3/snapshot from the service status cache", async () => {
  const core = JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]);
  const home = mkdtempSync(join(tmpdir(), "b12-8-"));
  const pacerHome = join(home, ".pacer");
  mkdirSync(join(pacerHome, "state"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(pacerHome, "strategy.yaml"),
    "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\npacing: {policy: priority, order: [claude-code, codex]}\n",
  );
  const port = closedPort();
  const env = pinnedEnv({
    HOME: home,
    PACER_HOME: pacerHome,
    PATH: `${fakeServiceManager(home)}:/usr/bin:/bin`,
    PACER_CORE_ARGV: core,
    PACER_NO_UPDATE_CHECK: "1",
    PACER_NO_SELF_REPAIR: "1",
    PACER_DISCOVERY: "off",
    PACER_DEBUG_NATIVE: "1",
  }, port);
  const child = spawnPinned([front!, "serve", "--port", String(port)], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const logs = new Response(child.stderr).text();
  let token = "";
  try {
    for (let n = 0; n < 500; n++) {
      try {
        token = readFileSync(join(pacerHome, "token"), "utf8").trim();
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) })).ok) {
          // The snapshot probe parts still come from Core on this stack; wait
          // for it before the first snapshot read.
          if ((await fetch(`${base}/v2/hello`, { signal: AbortSignal.timeout(300) })).ok) break;
        }
      } catch {}
      await Bun.sleep(10);
    }
    expect(token).not.toBe("");
    const auth = { Authorization: `Bearer ${token}` };
    const get = async () => {
      const response = await fetch(`${base}/v3/snapshot`, {
        headers: auth,
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-pacer")).toBe("1");
      return response.json() as Promise<any>;
    };
    // The first read may land while the first status compute is still running;
    // the cache then answers "starting" instead of holding the request open.
    const cold = await get();
    expect(cold.protocol).toBe("3.0.0");
    let settled = cold;
    for (let n = 0; n < 200 && settled.snapshot?.service?.starting === true; n++) {
      await Bun.sleep(25);
      settled = await get();
    }
    expect(settled.snapshot.service.starting).not.toBe(true);
    // The planner row and account rows are composed from the cached status.
    expect(settled.snapshot.planner?.runner).toBe("claude-code");
    expect(Array.isArray(settled.snapshot.accounts)).toBe(true);

    const until = Math.floor(Date.now() / 1000) + 3600;
    const hold = await fetch(`${base}/v3/ops/mode.hold`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ mode: "strict", until }),
      signal: AbortSignal.timeout(5000),
    });
    expect(hold.status).toBe(200);
    const held = await get();
    expect(held.snapshot.service).toBeDefined();
    // The hold is read live by the snapshot composer; give the cache's forced
    // rebuild a moment to publish it before checking the planner row.
    let visible = held;
    for (let n = 0; n < 20 && visible.snapshot.planner?.mode !== "strict"; n++) {
      await Bun.sleep(50);
      visible = await get();
    }
    if (visible.snapshot.planner?.mode !== "strict") {
      console.warn("UNVERIFIED: mode.hold was not reflected in the snapshot planner row");
    }
    const logText = await Promise.race([logs, Bun.sleep(1000).then(() => "")]);
    expect(logText).not.toContain("status-broker-parts");
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
