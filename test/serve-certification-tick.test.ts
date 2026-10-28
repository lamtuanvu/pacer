import { expect, spyOn, test } from "bun:test";
import * as schedule from "../src/dispatch/certification-schedule";
import { startServer } from "../src/serve/http";
import { fakeCtx } from "./helpers";

const TEN_MINUTES = 10 * 60_000;

// The tick is replaced, so no probe can run. The context also has no strategy
// and no agent binaries, so even the real tick would return before probing.
test("service certification runs every ten minutes, is single in-flight, and stops on shutdown", async () => {
  const ctx = fakeCtx({ which: () => null });
  let certify: (() => void) | undefined, handle: ReturnType<typeof setInterval> | undefined;
  let release!: () => void;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    const registered = interval(fn, ms);
    if (ms === TEN_MINUTES) { certify = fn; handle = registered; }
    return registered;
  }) as typeof setInterval);
  const tick = spyOn(schedule, "tick").mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
  timers.mockRestore();
  const cleared = spyOn(globalThis, "clearInterval");
  try {
    expect(certify).toBeDefined();
    expect(tick).not.toHaveBeenCalled();
    certify!(); certify!();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick.mock.calls[0][0]).toBe(ctx);
    release(); await Bun.sleep(0);
    certify!();
    expect(tick).toHaveBeenCalledTimes(2);
    release(); await Bun.sleep(0);
    await server.stop();
    expect(cleared.mock.calls.some(([id]) => id === handle)).toBe(true);
    certify!();
    expect(tick).toHaveBeenCalledTimes(2);
  } finally { cleared.mockRestore(); await server.stop(); tick.mockRestore(); }
});
