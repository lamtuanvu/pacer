import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { pumpOnce, defaultPumpDeps, type PumpDeps } from "../src/link/pump";
import { createTask, updateTask } from "../src/tasks/store";
import { readLatest } from "../src/link/store";
import { latestPath } from "../src/link/paths";
import { reduce } from "../src/link/envelope";
import { writeJsonAtomic } from "../src/fsutil";
import type { Status } from "../src/engine/status";

function fixture() {
  const ctx = fakeCtx({ which: () => null });
  const task = createTask(ctx, { brief: { goal: "quiet task", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; t.resolved = "reviewed"; });
  let statuses = 0, reads = 0, backfills = 0;
  const deps: PumpDeps = {
    ...defaultPumpDeps,
    status: async () => {
      statuses++;
      return { generatedAt: ctx.now, strategy: "s", planner: "p", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } } as unknown as Status;
    },
    backfillRepos: async () => { backfills++; },
    tasks: (c, ids) => { reads++; return defaultPumpDeps.tasks(c, ids); },
    publish: async (c, events) => {
      let latest = readLatest(c);
      for (const event of events) latest = reduce(latest, event, c.now);
      writeJsonAtomic(latestPath(c), latest);
      return { seq: latest.seq, transports: ["outbox"], errors: [] };
    },
  };
  const poll = (offset: number) => pumpOnce({ ...ctx, now: ctx.now + offset }, deps, { poll: true });
  return { ctx, task, poll, counts: () => ({ statuses, reads, backfills }) };
}

test("quiet fast polls skip task decoding and status until the periodic pass", async () => {
  const f = fixture();
  await f.poll(0);
  const before = f.counts();
  for (let i = 1; i < 30; i++) expect(await f.poll(i / 2)).toEqual([]);
  expect(f.counts()).toEqual(before);
  await f.poll(15);
  expect(f.counts().statuses).toBe(before.statuses + 1);
  expect(f.counts().backfills).toBe(before.backfills + 1);
});

test("fast polls publish settled changes without recomputing status", async () => {
  const f = fixture();
  await f.poll(0);
  const before = f.counts();
  updateTask(f.ctx, f.task.id, t => { t.title = "changed between periodic passes"; });
  const events = await f.poll(0.5);
  expect(events.filter(e => e.type === "task")).toMatchObject([{ data: { id: f.task.id, title: "changed between periodic passes" } }]);
  expect(f.counts().statuses).toBe(before.statuses);
  expect((await f.poll(1)).filter(e => e.type === "task")).toEqual([]);
});

test("fast polls check active tasks even when the task change head is unchanged", async () => {
  const f = fixture();
  updateTask(f.ctx, f.task.id, t => { t.state = "queued"; t.queue = { reason: "waiting_retry", nextAt: f.ctx.now + 3600, since: f.ctx.now, position: 1 }; });
  await f.poll(0);
  const before = f.counts();
  await f.poll(0.5);
  expect(f.counts().reads).toBeGreaterThan(before.reads);
  expect(f.counts().statuses).toBe(before.statuses);
});

test("fast transitions deliver notifications without waiting for the entity pass", async () => {
  const { capacityFixture } = await import("./read-model-helpers");
  const { register } = await import("../src/clients/registry");
  const { setLevel } = await import("../src/core/notify");
  const { publish } = await import("../src/link/publish");
  for (const offset of [0.5, 16]) {
    const ctx = fakeCtx({ which: () => null });
    const { s, st } = capacityFixture();
    register(ctx, { kind: "desktop", version: "1", notifier: true });
    setLevel(ctx, "all");
    const task = createTask(ctx, { brief: { goal: "transition", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, task.id, t => { t.state = "done"; t.resolved = "reviewed"; });
    let statuses = 0, setups = 0;
    const deps: PumpDeps = { ...defaultPumpDeps, publish, strategy: () => s,
      status: async () => { statuses++; return st; }, probeHosts: async () => [],
      setup: async () => { setups++; return { checkedAt: ctx.now, complete: true, ready: false, items: [] }; },
      backfillRepos: async () => {},
    };
    await pumpOnce(ctx, deps, { poll: true });
    updateTask(ctx, task.id, t => { t.state = "stopped"; });
    const out = await pumpOnce({ ...ctx, now: ctx.now + offset }, deps, { poll: true });
    const notifications = out.filter(e => e.type === "entity" && e.data.kind === "notify"
      && e.data.id.startsWith(`task:${task.id}:stopped:`));
    expect(notifications).toHaveLength(1);
    if (offset < 15) {
      expect(statuses).toBe(1);
      expect(setups).toBe(1);
      expect(out.some(e => e.type === "entity" && e.data.kind !== "notify")).toBe(false);
    }
    const later = await pumpOnce({ ...ctx, now: ctx.now + 32 }, deps, { poll: true });
    expect(later.filter(e => e.type === "entity" && e.data.kind === "notify"
      && e.data.id.startsWith(`task:${task.id}:stopped:`))).toHaveLength(0);
  }
});

test("a recovered stopped transition still delivers its notification", async () => {
  const { capacityFixture } = await import("./read-model-helpers");
  const { register } = await import("../src/clients/registry");
  const { setLevel } = await import("../src/core/notify");
  const { defaultLedgerApi } = await import("../src/link/ledger");
  const { publish } = await import("../src/link/publish");
  const ctx = fakeCtx({ which: () => null });
  const { s, st } = capacityFixture();
  register(ctx, { kind: "desktop", version: "1", notifier: true });
  setLevel(ctx, "all");
  const task = createTask(ctx, { brief: { goal: "recovered transition", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; t.resolved = "reviewed"; });
  const deps: PumpDeps = { ...defaultPumpDeps, publish, strategy: () => s, status: async () => st,
    probeHosts: async () => [], backfillRepos: async () => {},
    setup: async () => ({ checkedAt: ctx.now, complete: true, ready: false, items: [] }),
  };
  await pumpOnce(ctx, deps, { poll: true });
  updateTask(ctx, task.id, t => { t.state = "stopped"; });
  await expect(pumpOnce({ ...ctx, now: ctx.now + 0.5 }, deps, { poll: true,
    ledger: { ...defaultLedgerApi, writeLedger: () => { throw Error("checkpoint interrupted"); } },
  })).rejects.toThrow("checkpoint interrupted");
  // Recovery succeeds but a later status read fails; candidates must survive
  // this extra tick, not exist only in the recovery call's local array.
  await pumpOnce({ ...ctx, now: ctx.now + 2 }, { ...deps, status: async () => { throw Error("temporary status failure"); } });
  const out = await pumpOnce({ ...ctx, now: ctx.now + 16 }, deps, { poll: true });
  expect(out.filter(e => e.type === "task")).toHaveLength(0);
  expect(out.filter(e => e.type === "entity" && e.data.kind === "notify"
    && e.data.id.startsWith(`task:${task.id}:stopped:`))).toHaveLength(1);
});

test("a recovered notification retries after notification publication fails", async () => {
  const { capacityFixture } = await import("./read-model-helpers");
  const { register } = await import("../src/clients/registry");
  const { setLevel } = await import("../src/core/notify");
  const { defaultLedgerApi } = await import("../src/link/ledger");
  const { publish } = await import("../src/link/publish");
  const ctx = fakeCtx({ which: () => null });
  const { s, st } = capacityFixture();
  register(ctx, { kind: "desktop", version: "1", notifier: true });
  setLevel(ctx, "all");
  const task = createTask(ctx, { brief: { goal: "recovered transition", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, t => { t.state = "done"; t.resolved = "reviewed"; });
  const deps: PumpDeps = { ...defaultPumpDeps, publish, strategy: () => s, status: async () => st,
    probeHosts: async () => [], backfillRepos: async () => {},
    setup: async () => ({ checkedAt: ctx.now, complete: true, ready: false, items: [] }),
  };
  await pumpOnce(ctx, deps, { poll: true });
  updateTask(ctx, task.id, t => { t.state = "stopped"; });
  await expect(pumpOnce({ ...ctx, now: ctx.now + 0.5 }, deps, { poll: true,
    ledger: { ...defaultLedgerApi, writeLedger: () => { throw Error("checkpoint interrupted"); } },
  })).rejects.toThrow("checkpoint interrupted");
  // Recovery succeeds but a later status read fails; candidates must survive
  // this extra tick, not exist only in the recovery call's local array.
  await pumpOnce({ ...ctx, now: ctx.now + 2 }, { ...deps, publish: async (c, events, prepare) => {
    if (events.some(e => e.type === "entity" && e.data.kind === "notify"))
      return { seq: 0, transports: [], errors: ["temporary notification failure"] };
    return publish(c, events, prepare);
  } }, { poll: true });
  const out = await pumpOnce({ ...ctx, now: ctx.now + 16 }, deps, { poll: true });
  expect(out.filter(e => e.type === "task")).toHaveLength(0);
  expect(out.filter(e => e.type === "entity" && e.data.kind === "notify"
    && e.data.id.startsWith(`task:${task.id}:stopped:`))).toHaveLength(1);
});
