import { expect, test } from "bun:test";
import { CallAdmission } from "../src/plugins/admission";

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
