import { expect, spyOn, test } from "bun:test";
import * as events from "../src/api/events";
import { startServer } from "../src/serve/http";
import { capacityFixture } from "./read-model-helpers";
import { fakeCtx } from "./helpers";

test("HTTP v2 and v3 share cold snapshot work and serve stale while rebuilding", async () => {
  const ctx = fakeCtx({ which: () => null });
  const { st } = capacityFixture();
  const initial = await events.liveSnapshot(ctx, { status: async () => st });
  let resolve!: (value: typeof initial) => void;
  let calls = 0;
  const build = spyOn(events, "liveSnapshot").mockImplementation(() => {
    calls++;
    return new Promise(yes => { resolve = yes; });
  });
  const server = startServer(() => ctx, { port: 0, pumpMs: 0 });
  const get = async (path = "/v3/snapshot") => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(200);
    return response.json() as Promise<typeof initial>;
  };
  try {
    const a = get(), b = get("/v2/snapshot");
    for (let n = 0; n < 100 && !calls; n++) await Bun.sleep(5);
    expect(calls).toBe(1);
    resolve(initial);
    const [v3, v2] = await Promise.all([a, b]);
    expect(v3.protocol).toBe("3.1.0");
    expect(v2.protocol).toBe("2.8.0");
    await Bun.sleep(1100);
    expect((await get()).seq).toBe(initial.seq);
    for (let n = 0; n < 100 && calls < 2; n++) await Bun.sleep(5);
    expect(calls).toBe(2);
    expect((await get()).seq).toBe(initial.seq);
    expect((await get("/v2/snapshot")).protocol).toBe("2.8.0");
    expect(calls).toBe(2);
    resolve({ ...initial, seq: initial.seq + 1 });
    await Bun.sleep(20);
    expect((await get()).seq).toBe(initial.seq + 1);
  } finally { resolve?.(initial); server.stop(); build.mockRestore(); }
}, 10000);
