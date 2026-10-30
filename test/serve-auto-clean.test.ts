import {expect, spyOn, test} from "bun:test";
import * as tasks from "../src/core/tasks";
import {startServer} from "../src/serve/http";
import {fakeCtx} from "./helpers";

// Exercise the service timer wiring without removing any resources.
test("service sweeps on startup and hourly, avoids overlap and stops on shutdown", async () => {
  const ctx = fakeCtx({which: () => null});
  let sweep: (() => void) | undefined, handle: ReturnType<typeof setInterval> | undefined;
  const interval = globalThis.setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
    const registered = interval(fn, ms);
    if (ms === 60 * 60_000) {sweep = fn; handle = registered;}
    return registered;
  }) as typeof setInterval);
  let release!: () => void;
  const tick = spyOn(tasks, "autoCleanSweep").mockImplementation(() => new Promise<void>(resolve => {release = resolve;}));
  const server = startServer(() => ctx, {port: 0, listener: false, pumpMs: 0});
  timers.mockRestore();
  const cleared = spyOn(globalThis, "clearInterval");
  try {
    await Bun.sleep(20);
    expect(sweep).toBeDefined();
    expect(tick).toHaveBeenCalledTimes(1);
    sweep!(); sweep!();
    await Bun.sleep(0);
    expect(tick).toHaveBeenCalledTimes(1);
    release(); await Bun.sleep(0);
    sweep!(); await Bun.sleep(0);
    expect(tick).toHaveBeenCalledTimes(2);
    release(); await Bun.sleep(0);
    await server.stop();
    expect(cleared.mock.calls.some(([id]) => id === handle)).toBe(true);
    sweep!(); await Bun.sleep(0);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {release?.(); cleared.mockRestore(); await server.stop(); tick.mockRestore();}
});

test("service startup cleanup without a strategy does not warn", async () => {
  const ctx = fakeCtx({which: () => null});
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  const server = startServer(() => ctx, {port: 0, listener: false, pumpMs: 0});
  try {
    await Bun.sleep(50);
    expect(warnings.mock.calls.some(([message]) => String(message).includes("automatic cleanup failed"))).toBe(false);
  } finally {
    await server.stop();
    warnings.mockRestore();
  }
});
