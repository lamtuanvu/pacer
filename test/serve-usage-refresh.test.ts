import { expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as status from "../src/engine/status";
import * as usageRefresh from "../src/usage/refresh";
import { startServer } from "../src/serve/http";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx } from "./helpers";

test("manual usage refresh rebuilds status after an older status build finishes", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n");
  const { st } = capacityFixture();
  type Computed = Awaited<ReturnType<typeof status.computeStatus>>;
  const computed = st as Computed;
  let finishFirst!: (value: Computed) => void;
  let calls = 0;
  const first = new Promise<Computed>(resolve => { finishFirst = resolve; });
  const compute = spyOn(status, "computeStatus").mockImplementation(async () => ++calls === 1 ? first : computed);
  let releaseAutomatic!: () => void;
  const automaticHeld = new Promise<void>(resolve => { releaseAutomatic = resolve; });
  let markAutomaticStarted!: () => void;
  const automaticStarted = new Promise<void>(resolve => { markAutomaticStarted = resolve; });
  const refresh = spyOn(usageRefresh, "refreshAllUsage").mockImplementation(async (_ctx, automatic) => {
    if (automatic) { markAutomaticStarted(); await automaticHeld; }
    return [];
  });
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  try {
    for (let n = 0; n < 100 && !calls; n++) await Bun.sleep(5);
    expect(calls).toBe(1);
    const request = fetch(`http://127.0.0.1:${server.port}/v3/ops/limits.refresh`, {
      method: "POST", headers: { Authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(5_000),
    });
    // Wait for the scheduled automatic call, even under a loaded test runner.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("automatic refresh did not start")), 5_000);
      automaticStarted.then(() => { clearTimeout(timer); resolve(); });
    });
    expect(calls).toBe(1);
    finishFirst(computed);
    const response = await request;
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  } finally {
    finishFirst(computed);
    try { await server.stop(); }
    finally { releaseAutomatic(); refresh.mockRestore(); compute.mockRestore(); }
  }
}, 10_000);

test("the running service refreshes configured usage while executors are idle", async () => {
  const ctx = fakeCtx({ which: () => null });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\naccounts:\n  claude-code: {kind: claude}\n");
  const refresh = spyOn(usageRefresh, "refreshAllUsage").mockResolvedValue([]);
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  try {
    for (let n = 0; n < 100 && !refresh.mock.calls.length; n++) await Bun.sleep(20);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.[1]).toBe(true);
  } finally { refresh.mockRestore(); await server.stop(); }
}, 5_000);
