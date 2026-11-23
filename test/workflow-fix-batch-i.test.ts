// Phase 6 batch I: heartbeat try/catch + withEntryLease, startEntryIfNeeded heartbeat,
// last_transient gap restart, harness-gated lease knobs, UNIQUE interleave, two-connection
// heartbeat hold, schema migrate from batch G/H, clearInterval on every exit.
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { createTask, readTask, taskDatabase } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { registerWork } from "../src/dispatch/work";
import { harnessEntryOverrides, makeCtx } from "../src/ctx";
import * as store from "../src/workflow/store";
import {
  addDefinition, bumpEntryStartAttempts, claimEntryLease, clearEntryLease, getRun, insertRun,
  insertStep, leaseNow, liveRunsNeedingEntry, newEntryOwner,
  resetWorkflowSchemaReadyForTests, stepsOfRun, workflowDatabase,
  ENTRY_LEASE_S, ENTRY_START_TRANSIENT_GAP_S, ENTRY_START_TRANSIENT_MAX,
  ENTRY_START_TRANSIENT_MIN_S, entryLeaseSeconds, startRunDelayMs,
} from "../src/workflow/store";
import {
  defaultEngineDeps, renewEntryLease, startEntryIfNeeded, startPendingEntries, startRun,
  withEntryLease, type EngineDeps,
} from "../src/workflow/engine";
import * as pacing from "../src/workflow/pacing";
import { pauseRunByPerson } from "../src/workflow/pacing";

const NOW = 1_700_000_000;

const CHAIN = {
  id: "t/batch-i",
  version: 1,
  entry: "one",
  steps: {
    one: { type: "agent" as const, kind: "research", prompt: "One" },
    two: { type: "agent" as const, kind: "research", prompt: "Two" },
    done: { type: "end" as const },
  },
  edges: [
    { from: "one", to: "two" },
    { from: "two", to: "done" },
  ],
};

const END_ONLY = {
  id: "t/batch-i-end",
  version: 1,
  entry: "done",
  steps: { done: { type: "end" as const } },
  edges: [] as { from: string; to: string }[],
};

function stubDeps(): { deps: EngineDeps } {
  const byRequest = new Map<string, TaskRecord>();
  const delegate: EngineDeps["delegate"] = async (ctx, input: DelegateInput) => {
    const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
    if (prior) return readTask(ctx, prior.id) ?? prior;
    const task = createTask(ctx, {
      brief: input.brief,
      kind: input.kind ?? null,
      requestedExecutor: null,
      timeoutS: 600,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    });
    if (input.workParent || input.dispatch) {
      registerWork(ctx, task.id, { ...input.dispatch }, input.workParent);
    }
    if (input.requestId) byRequest.set(input.requestId, task);
    return task;
  };
  return { deps: { ...defaultEngineDeps, delegate } };
}

function addChain(ctx: Ctx, def: Parameters<typeof addDefinition>[1] = CHAIN): void {
  addDefinition(ctx, def, "source");
}

function entryTasks(ctx: Ctx, runId: string): number {
  return stepsOfRun(ctx, runId).filter(s => s.stepId === "one" && s.taskId).length;
}

/** Fake timers: capture setInterval callbacks; fire via tick(); track clearInterval. */
function installFakeTimers(ctx: Ctx): {
  tick: () => void;
  cleared: number[];
  scheduled: number;
} {
  const callbacks: Array<() => void> = [];
  const cleared: number[] = [];
  let nextId = 1;
  const handles = new Map<number, () => void>();
  ctx.setInterval = ((fn: () => void, _ms?: number) => {
    const id = nextId++;
    const wrapped = () => { fn(); };
    callbacks.push(wrapped);
    handles.set(id, wrapped);
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  ctx.clearInterval = ((id: ReturnType<typeof setInterval>) => {
    const n = id as unknown as number;
    cleared.push(n);
    handles.delete(n);
  }) as typeof clearInterval;
  return {
    tick: () => { for (const cb of [...callbacks]) cb(); },
    cleared,
    get scheduled() { return handles.size; },
  };
}

describe("batch I: heartbeat try/catch and lease-unknown", () => {
  test("renewEntryLease returns unknown for non-transient errors (never throws)", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "renew-unknown",
      entryOwner: newEntryOwner(), entryLeaseUntil: NOW + 30,
    });
    const owner = getRun(ctx, run.id)!.entryOwner!;
    const claim = spyOn(store, "claimEntryLease").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(renewEntryLease(ctx, run.id, owner)).toBe("unknown");
      expect(warn.mock.calls.some(c => String(c[0]).includes("renewEntryLease"))).toBe(true);
    } finally {
      claim.mockRestore();
      warn.mockRestore();
    }
  });

  test("heartbeat that throws is caught: leaseLost; clearInterval; never failRun", async () => {
    const ctx = fakeCtx({ now: NOW, entryLeaseS: 3 });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "hb-throw",
    });
    const owner = newEntryOwner();
    expect(claimEntryLease(ctx, run.id, owner, NOW + 3, NOW)).toBe(true);
    const timers = installFakeTimers(ctx);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // Make renewEntryLease's claim throw so the heartbeat catch path runs.
    const claimSpy = spyOn(store, "claimEntryLease").mockImplementation(() => {
      throw new Error("closed DB handle");
    });
    try {
      const held = await withEntryLease(ctx, run.id, owner, async (ctl) => {
        timers.tick();
        expect(ctl.lost()).toBe(true);
        return getRun(ctx, run.id)!;
      });
      expect(held.leaseLost).toBe(true);
      expect(held.value!.status).toBe("running");
      expect(held.value!.reason).toBeUndefined();
      expect(timers.cleared.length).toBe(1);
      expect(timers.scheduled).toBe(0);
      expect(warn.mock.calls.some(c => String(c[0]).includes("renewEntryLease") || String(c[0]).includes("heartbeat"))).toBe(true);
    } finally {
      claimSpy.mockRestore();
      warn.mockRestore();
    }
  });

  test("withEntryLease clearInterval on success, throw, and lost-lease exits", async () => {
    const ctx = fakeCtx({ now: NOW, entryLeaseS: 9 });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "clears",
    });
    const owner = newEntryOwner();
    expect(claimEntryLease(ctx, run.id, owner, NOW + 9, NOW)).toBe(true);

    // Success path
    {
      const timers = installFakeTimers(ctx);
      const held = await withEntryLease(ctx, run.id, owner, async () => "ok");
      expect(held.value).toBe("ok");
      expect(timers.cleared.length).toBe(1);
      expect(timers.scheduled).toBe(0);
    }
    // Re-claim for throw path
    expect(claimEntryLease(ctx, run.id, owner, NOW + 9, NOW)).toBe(true);
    {
      const timers = installFakeTimers(ctx);
      const held = await withEntryLease(ctx, run.id, owner, async () => {
        throw new Error("boom");
      });
      expect(held.error).toBeInstanceOf(Error);
      expect(timers.cleared.length).toBe(1);
    }
    // Lost-lease path: competing owner steals; renew reports lost; fn stops
    expect(claimEntryLease(ctx, run.id, owner, NOW + 9, NOW)).toBe(true);
    const other = newEntryOwner();
    {
      const timers = installFakeTimers(ctx);
      const held = await withEntryLease(ctx, run.id, owner, async (ctl) => {
        (ctx as { now: number }).now = NOW + ENTRY_LEASE_S + 1;
        expect(claimEntryLease(ctx, run.id, other, leaseNow(ctx) + 9, leaseNow(ctx))).toBe(true);
        expect(ctl.renew()).toBe(false);
        expect(ctl.lost()).toBe(true);
        return "stopped";
      });
      expect(held.value).toBe("stopped");
      expect(held.leaseLost).toBe(true);
      expect(timers.cleared.length).toBe(1);
      // New owner's lease must not be cleared.
      expect(getRun(ctx, run.id)!.entryOwner).toBe(other);
    }
  });
});

describe("batch I: startEntryIfNeeded shares withEntryLease heartbeat", () => {
  test("slow startEntryIfNeeded longer than lease keeps ownership; second connection cannot claim", async () => {
    const ctx = fakeCtx({ now: NOW, entryLeaseS: 5 });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "entry-hb",
    });
    clearEntryLease(ctx, run.id);
    const dbPath = join(ctx.pacerHome, "state/tasks.db");
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const ownerA = newEntryOwner();
    const tickOwner = newEntryOwner();
    let competing = true;
    const timers = installFakeTimers(ctx);
    try {
      const started = await startEntryIfNeeded(ctx, run.id, {
        deps,
        entryOwner: ownerA,
        afterEntryClaim: async (c, id) => {
          // Advance past the original lease; heartbeat renew keeps A ahead of B.
          (c as { now: number }).now = NOW + 20;
          timers.tick();
          competing = claimEntryLease(
            c, id, tickOwner, leaseNow(c) + 5, leaseNow(c), db2,
          );
          expect(competing).toBe(false);
        },
      });
      expect(started).toBe(true);
      expect(competing).toBe(false);
      expect(entryTasks(ctx, run.id)).toBe(1);
      expect(getRun(ctx, run.id)!.status).toBe("running");
      expect(getRun(ctx, run.id)!.reason).toBeUndefined();
      expect(timers.cleared.length).toBeGreaterThanOrEqual(1);
    } finally {
      db2.close();
    }
  });

  test("lost lease during startEntryIfNeeded: stop cleanly, no failRun, no double entry", async () => {
    const ctx = fakeCtx({ now: NOW, entryLeaseS: 3 });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "entry-lost",
    });
    clearEntryLease(ctx, run.id);
    const other = newEntryOwner();
    const started = await startEntryIfNeeded(ctx, run.id, {
      deps,
      afterEntryClaim: async (c, id) => {
        (c as { now: number }).now = NOW + 100;
        expect(claimEntryLease(c, id, other, leaseNow(c) + 3, leaseNow(c))).toBe(true);
        // Winner already inserted entry so loser must not double-apply.
        insertStep(c, { runId: id, stepId: "one", attempt: 1, status: "running" });
      },
    });
    expect(started).toBe(false);
    expect(getRun(ctx, run.id)!.status).toBe("running");
    expect(getRun(ctx, run.id)!.reason).toBeUndefined();
    expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
    expect(getRun(ctx, run.id)!.entryOwner).toBe(other);
  });
});

describe("batch I: last_transient gap restart", () => {
  test("blip then long gap then one fresh transient does NOT fail; sustained past window fails", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "gap",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_i_lock BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    await startPendingEntries(ctx, { deps });
    expect(getRun(ctx, run.id)!.entryStartAttempts).toBe(1);
    expect(getRun(ctx, run.id)!.entryFirstTransientAt).toBe(NOW);
    // Long quiet gap — window restarts on the next blip.
    (ctx as { now: number }).now = NOW + ENTRY_START_TRANSIENT_GAP_S + 10;
    await startPendingEntries(ctx, { deps });
    const afterGap = getRun(ctx, run.id)!;
    expect(afterGap.status).toBe("running");
    expect(afterGap.entryStartAttempts).toBe(1);
    expect(afterGap.entryFirstTransientAt).toBe(NOW + ENTRY_START_TRANSIENT_GAP_S + 10);
    // Sustained: refresh last_transient within the gap cadence, then cross the window.
    const windowStart = afterGap.entryFirstTransientAt!;
    for (let t = 30; t <= ENTRY_START_TRANSIENT_MIN_S - 10; t += 30) {
      (ctx as { now: number }).now = windowStart + t;
      await startPendingEntries(ctx, { deps });
    }
    (ctx as { now: number }).now = windowStart + ENTRY_START_TRANSIENT_MIN_S + 1;
    await startPendingEntries(ctx, { deps });
    const failed = getRun(ctx, run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toMatch(/entry start failed after \d+\.\d+s \(/);
    expect(failed.reason).toMatch(/locked/i);
  });

  test("paused skip resets the transient window", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "pause-reset",
    });
    bumpEntryStartAttempts(ctx, run.id, NOW);
    expect(getRun(ctx, run.id)!.entryStartAttempts).toBe(1);
    pauseRunByPerson(ctx, run.id, getRun(ctx, run.id)!.rev);
    expect(await startEntryIfNeeded(ctx, run.id, stubDeps())).toBe(false);
    expect(getRun(ctx, run.id)!.entryStartAttempts ?? 0).toBe(0);
    expect(getRun(ctx, run.id)!.entryFirstTransientAt).toBeUndefined();
  });

  test("reset-on-success clears first and last transient stamps", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "reset-ok",
    });
    bumpEntryStartAttempts(ctx, run.id, NOW);
    clearEntryLease(ctx, run.id);
    expect(await startEntryIfNeeded(ctx, run.id, { deps })).toBe(true);
    expect(getRun(ctx, run.id)!.entryStartAttempts ?? 0).toBe(0);
    expect(getRun(ctx, run.id)!.entryFirstTransientAt).toBeUndefined();
    expect(getRun(ctx, run.id)!.entryLastTransientAt).toBeUndefined();
  });
});

describe("batch I: harness-gated lease knobs (no $PACER_HOME files)", () => {
  test("production ignores PACER_TEST_* without harness flag; files under home are ignored", () => {
    const home = tmpDir();
    const pacerHome = join(home, ".pacer");
    mkdirSync(pacerHome, { recursive: true });
    writeFileSync(join(pacerHome, "entry-lease-s"), "3\n");
    writeFileSync(join(pacerHome, "start-run-delay-ms"), "8000\n");
    const ctx = makeCtx({
      home, pacerHome, now: NOW,
      env: {
        HOME: home, PACER_HOME: pacerHome,
        PACER_TEST_ENTRY_LEASE_S: "3",
        PACER_TEST_START_DELAY_MS: "8000",
        // no PACER_LIVE_HARNESS / NODE_ENV=test
      },
      run: async () => ({ code: 127, stdout: "", stderr: "" }),
      which: () => null,
    });
    expect(entryLeaseSeconds(ctx)).toBe(ENTRY_LEASE_S);
    expect(startRunDelayMs(ctx)).toBe(0);
    expect(harnessEntryOverrides({ PACER_TEST_ENTRY_LEASE_S: "3" })).toEqual({});
  });

  test("PACER_LIVE_HARNESS + PACER_TEST_* applied once via makeCtx onto Ctx fields", () => {
    const home = tmpDir();
    const ctx = makeCtx({
      home, pacerHome: join(home, ".pacer"), now: NOW,
      env: {
        HOME: home, PACER_HOME: join(home, ".pacer"),
        PACER_LIVE_HARNESS: "1",
        PACER_TEST_ENTRY_LEASE_S: "3",
        PACER_TEST_START_DELAY_MS: "8000",
      },
      run: async () => ({ code: 127, stdout: "", stderr: "" }),
      which: () => null,
    });
    expect(ctx.entryLeaseS).toBe(3);
    expect(ctx.startRunDelayMs).toBe(8000);
    expect(entryLeaseSeconds(ctx)).toBe(3);
    expect(startRunDelayMs(ctx)).toBe(8000);
  });

  test("ENTRY_START_TRANSIENT_MAX keeps time primary under a 500ms pump floor", () => {
    expect(ENTRY_START_TRANSIENT_MAX).toBe(Math.ceil(ENTRY_START_TRANSIENT_MIN_S / 0.5) * 2);
    expect(ENTRY_START_TRANSIENT_MAX).toBeGreaterThanOrEqual(
      Math.ceil(ENTRY_START_TRANSIENT_MIN_S / 0.5),
    );
  });
});

describe("batch I: schema migration from batch G/H home", () => {
  test("workflowDatabase adds entry_last_transient_at on a batch-H-shaped home", () => {
    const ctx = fakeCtx({ now: NOW });
    const dbPath = join(ctx.pacerHome, "state/tasks.db");
    mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE workflow_runs(
        id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
        status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL,
        entry_lease_until REAL, entry_owner TEXT, entry_seed TEXT,
        entry_start_attempts INTEGER NOT NULL DEFAULT 0,
        entry_first_transient_at REAL
      );
      CREATE TABLE workflow_steps(
        run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT UNIQUE,
        status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL,
        PRIMARY KEY(run_id, step_id, attempt, branch)
      );
      CREATE TABLE workflow_defs(id TEXT, version INTEGER, source TEXT, def TEXT, added_at REAL, PRIMARY KEY(id, version));
      CREATE TABLE workflow_cursor(id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER);
      INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at, entry_start_attempts, entry_first_transient_at)
      VALUES ('run_h', 't/batch-i', 1, '/r', 'h', 'h', 'running', NULL, '{}', 1, 1, 1, 2, ${NOW});
    `);
    raw.close();
    resetWorkflowSchemaReadyForTests();
    taskDatabase(ctx);
    workflowDatabase(ctx);
    const cols = workflowDatabase(ctx).query<{ name: string }, []>("PRAGMA table_info(workflow_runs)").all().map(c => c.name);
    expect(cols).toContain("entry_last_transient_at");
    // Idempotent second pass
    resetWorkflowSchemaReadyForTests();
    workflowDatabase(ctx);
    const bumped = bumpEntryStartAttempts(ctx, "run_h", NOW + 5);
    expect(bumped.attempts).toBe(3);
    expect(bumped.firstAt).toBe(NOW);
    expect(bumped.lastAt).toBe(NOW + 5);
  });
});

describe("batch I: UNIQUE via afterEntryClaim + two-connection interleave", () => {
  test("afterEntryClaim second starter: exactly one entry task, run not failed", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "uniq-hook",
    });
    clearEntryLease(ctx, run.id);
    let winnerTask = "";
    const ok = await startEntryIfNeeded(ctx, run.id, {
      deps,
      afterEntryClaim: (c, id) => {
        const row = insertStep(c, { runId: id, stepId: "one", attempt: 1, status: "running" });
        const task = createTask(c, {
          brief: { goal: "winner", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
          requestId: `wf:${id}:one:1:`,
        });
        workflowDatabase(c).query(
          "UPDATE workflow_steps SET task_id = ? WHERE run_id = ? AND step_id = ? AND attempt = 1 AND branch = ''",
        ).run(task.id, id, "one");
        winnerTask = task.id;
        void row;
      },
    });
    expect(ok).toBe(true);
    expect(getRun(ctx, run.id)!.status).toBe("running");
    expect(getRun(ctx, run.id)!.reason).toBeUndefined();
    expect(entryTasks(ctx, run.id)).toBe(1);
    expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
    expect(stepsOfRun(ctx, run.id)[0]!.taskId).toBe(winnerTask);
  });

  test("starter A claims and is slow; B on second connection cannot claim while A heartbeats", async () => {
    const ctx = fakeCtx({ now: NOW, entryLeaseS: 4 });
    addChain(ctx);
    const { deps } = stubDeps();
    const timers = installFakeTimers(ctx);
    const dbPath = join(ctx.pacerHome, "state/tasks.db");
    workflowDatabase(ctx);
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const ownerB = newEntryOwner();
    let bClaims: boolean[] = [];
    const mode = spyOn(pacing, "readPacingMode").mockImplementation(async (c) => {
      // Fire heartbeats, advance clock past lease, B still loses.
      timers.tick();
      (c as { now: number }).now = NOW + 20;
      timers.tick();
      const rows = db2.query<{ id: string }, []>(
        "SELECT id FROM workflow_runs WHERE status IN ('running','waiting') ORDER BY created_at DESC LIMIT 1",
      ).all();
      const runId = rows[0]?.id ?? "";
      bClaims.push(claimEntryLease(c, runId, ownerB, leaseNow(c) + 4, leaseNow(c), db2));
      return "normal";
    });
    try {
      const run = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "interleave",
      }, undefined, deps);
      expect(bClaims.length).toBeGreaterThanOrEqual(1);
      expect(bClaims.every(x => x === false)).toBe(true);
      expect(entryTasks(ctx, run.id)).toBe(1);
      expect(run.status).toBe("running");
      expect(liveRunsNeedingEntry(ctx, { now: leaseNow(ctx) }).some(r => r.id === run.id)).toBe(false);
      expect(timers.cleared.length).toBeGreaterThanOrEqual(1);
    } finally {
      mode.mockRestore();
      db2.close();
    }
  });
});

describe("batch I: paused end entry waits for resume (documented behaviour)", () => {
  test("person-paused end-entry run stays running without completing at start", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    addChain(ctx, END_ONLY);
    const { deps } = stubDeps();
    const done = await startRun(ctx, {
      workflow: END_ONLY.id, repo: tmpDir(), brief: "end-parent",
    }, undefined, deps);
    // Unpaused end entry completes immediately at start.
    expect(done.status).toBe("done");
    // Child inherits person pause: end entry must NOT complete at start.
    const p = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "pause-parent",
    }, undefined, deps);
    pauseRunByPerson(ctx, p.id, getRun(ctx, p.id)!.rev);
    const child = await startRun(ctx, {
      workflow: END_ONLY.id, repo: tmpDir(), brief: "end-paused",
    }, undefined, deps, {
      parentRunId: p.id,
      parentStep: "one",
    });
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");
    expect(getRun(ctx, child.id)!.status).toBe("running");
    expect(stepsOfRun(ctx, child.id)).toHaveLength(0);
  });
});
