import { expect, test } from "bun:test";
import { CallAdmission } from "../src/plugins/admission";
import { CoreError } from "../src/core/errors";

test("eight active calls and thirty-two queued calls reject overflow without executing it", async () => {
  const admission = new CallAdmission();
  let started = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = Array.from({ length: 40 }, () => admission.run(Date.now() + 2000, async () => { started++; await gate; return 1; }));
  await Promise.resolve();
  expect(started).toBe(8);
  await expect(admission.run(Date.now() + 2000, async () => { started++; return 1; })).rejects.toThrow("capacity");
  release(); expect(await Promise.all(waiting)).toHaveLength(40);
  expect(started).toBe(40);
});

test("expired queued calls never acquire a new execution lifetime", async () => {
  const admission = new CallAdmission();
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holding = Array.from({ length: 8 }, () => admission.run(Date.now() + 2000, () => gate));
  const queued = admission.run(Date.now() + 10, async () => { started = true; });
  await expect(queued).rejects.toMatchObject({ code: "plugin_timeout" });
  release(); await Promise.all(holding);
  expect(started).toBe(false);
});

test("active cancellation awaits task cleanup and never returns its late value", async () => {
  const admission = new CallAdmission(), controller = new AbortController();
  let clean = false;
  const pending = admission.run(Date.now() + 2000, signal => new Promise(resolve => {
    signal.addEventListener("abort", () => { clean = true; resolve("late value"); }, { once: true });
  }), controller.signal);
  await Promise.resolve(); controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(clean).toBe(true);
});

test("parent timeout keeps its reason through active and pre-dispatch cancellation", async () => {
  const timeout = new CoreError("plugin_timeout", "host fetch expired");
  const before = new AbortController(); before.abort(timeout);
  await expect(new CallAdmission().run(Date.now() + 2000, async () => "wrong", before.signal))
    .rejects.toMatchObject({ code: "plugin_timeout", message: "host fetch expired" });

  const active = new AbortController();
  let clean = false;
  const pending = new CallAdmission().run(Date.now() + 2000, signal => new Promise(resolve => {
    signal.addEventListener("abort", () => { clean = true; resolve("late value"); }, { once: true });
  }), active.signal);
  await Promise.resolve(); active.abort(timeout);
  await expect(pending).rejects.toMatchObject({ code: "plugin_timeout", message: "host fetch expired" });
  expect(clean).toBe(true);
});

test("cancellation before task dispatch does not invoke a newly admitted task", async () => {
  const admission = new CallAdmission(), controller = new AbortController();
  let ran = false;
  const pending = admission.run(Date.now() + 2000, async () => { ran = true; }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "plugin_unavailable" });
  expect(ran).toBe(false);
});

test("work finishing after its absolute clock cannot win over a delayed timer callback", async () => {
  const admission = new CallAdmission();
  const pending = admission.run(Date.now() + 2, async () => {
    const end = Date.now() + 8; while (Date.now() < end) { /* A bounded synchronous decode occupies the event loop. */ }
    return "late value";
  });
  await expect(pending).rejects.toMatchObject({ code: "plugin_timeout" });
});

test("serial queue removes repeated canceled waiters instead of retaining promise tombstones", async () => {
  const { SerialCalls } = await import("../src/plugins/admission");
  const queue = new SerialCalls(), live = new AbortController();
  let release!: () => void, ran = 0;
  const first = queue.run(live.signal, () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  for (let i = 0; i < 64; i++) {
    const controller = new AbortController();
    const waiting = queue.run(controller.signal, async () => { ran++; });
    controller.abort(); await expect(waiting).rejects.toThrow("before execution");
  }
  expect((queue as any).queued).toHaveLength(0);
  release(); await first;
  expect(ran).toBe(0);
});

test("a pool with no queue refuses at once when full and names itself", async () => {
  const admission = new CallAdmission(2, 0, "session viewer stream");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = [admission.run(Infinity, () => gate), admission.run(Infinity, () => gate)];
  await expect(admission.run(Infinity, async () => 1))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: "session viewer stream capacity exhausted" });
  release(); await Promise.all(held);
  expect(await admission.run(Infinity, async () => 1)).toBe(1);
});
