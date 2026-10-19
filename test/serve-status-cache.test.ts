import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "../src/engine/status";
import { startServer } from "../src/serve/http";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx } from "./helpers";

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
