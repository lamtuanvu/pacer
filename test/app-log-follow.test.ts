import { expect, test } from "bun:test";
import { followLog } from "../app/src/screens/session/PlainLog";

function sourceFixture() {
  const sources: FakeSource[] = [];
  class FakeSource {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, (event: MessageEvent) => void>();
    closed = false;
    constructor(readonly url: string) { sources.push(this); }
    addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
  }
  return { sources, Source: FakeSource };
}
for (const major of [2, 3]) test(`plain log follows the negotiated v${major} service and closes on cleanup`, async () => {
  const { sources, Source } = sourceFixture(), received: string[] = [];
  const cleanup = followLog({ hello: async () => ({ protocol: `${major}.0.0`, pacer: "test", ops: [], events: [] }) }, "task / encoded", {
    open: () => received.push("open"), log: event => received.push(event.data), done: () => received.push("done"), error: () => received.push("error"),
  }, Source);
  await Bun.sleep(0);
  expect(sources.map(s => s.url)).toEqual([`/v${major}/tasks/task%20%2F%20encoded/log?follow=1`]);
  const source = sources[0]!;
  source.onopen?.(); source.listeners.get("log")!({ data: "output" } as MessageEvent);
  source.listeners.get("done")!({} as MessageEvent);
  expect(received).toEqual(["open", "output", "done"]);
  expect(source.closed).toBe(true);
  cleanup(); source.onerror?.(); source.onopen?.();
  expect(received).toEqual(["open", "output", "done"]);
});
test("plain log does not connect after unmount during hello negotiation", async () => {
  const { sources, Source } = sourceFixture();
  let resolve!: (value: { protocol: string; pacer: string; ops: string[]; events: string[] }) => void;
  const cleanup = followLog({ hello: () => new Promise(r => { resolve = r; }) }, "task", { open() {}, log() {}, done() {}, error() {} }, Source);
  cleanup(); resolve({ protocol: "3.0.0", pacer: "test", ops: [], events: [] });
  await Bun.sleep(0);
  expect(sources).toHaveLength(0);
});
test("plain log surfaces failed negotiation without silently falling back", async () => {
  const { sources, Source } = sourceFixture();
  let error: unknown;
  const failure = new Error("Session ended");
  const cleanup = followLog({ hello: async () => { throw failure; } }, "task", { open() {}, log() {}, done() {}, error(value) { error = value; } }, Source);
  await Bun.sleep(0);
  expect(error).toBe(failure); expect(sources).toHaveLength(0); cleanup();
});
