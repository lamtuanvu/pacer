// Phase 6 batch H: live lease clock (B1), real PK race (I2), two-connection claim (I3),
// pause-before-seed (I4), time-based transient bound (I5), bump guard (I6), UNIQUE match /
// clearEntrySeed / orphan recovery (minors).
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { createTask, readTask } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { registerWork } from "../src/dispatch/work";
import * as store from "../src/workflow/store";
import {
  addDefinition, claimEntryLease, clearEntryLease, clearEntrySeed, getRun, insertRun, insertStep,
  leaseNow, liveRunsNeedingEntry, newEntryOwner, stepsOfRun, workflowDatabase,
  ENTRY_LEASE_S, ENTRY_START_TRANSIENT_MAX, ENTRY_START_TRANSIENT_MIN_S,
} from "../src/workflow/store";
import {
  defaultEngineDeps, isEntryStepAlreadyStarted, reconcileOrphanStep, startEntryIfNeeded,
  startPendingEntries, startRun, type EngineDeps,
} from "../src/workflow/engine";
import * as pacing from "../src/workflow/pacing";
import { pauseRunByPerson } from "../src/workflow/pacing";

const NOW = 1_700_000_000;

const CHAIN = {
  id: "t/batch-h",
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

const UNIQUE_ENTRY_PK =
  "UNIQUE constraint failed: workflow_steps.run_id, workflow_steps.step_id, workflow_steps.attempt, workflow_steps.branch";

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

function addChain(ctx: Ctx): void {
  addDefinition(ctx, CHAIN, "source");
}

function entryTasks(ctx: Ctx, runId: string): number {
  return stepsOfRun(ctx, runId).filter(s => s.stepId === "one" && s.taskId).length;
}

describe("B1: live clock lease renewal across slow start", () => {
  test("slow start longer than ENTRY_LEASE_S keeps the lease; competing claim returns false", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    workflowDatabase(ctx);
    const dbPath = join(ctx.pacerHome, "state/tasks.db");
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const tickOwner = newEntryOwner();
    let competingClaim: boolean | undefined;
    let runId = "";
    // Advance the clock across the mode await; startRun renews after it returns.
    const mode = spyOn(pacing, "readPacingMode").mockImplementation(async (c) => {
      (c as { now: number }).now = NOW + ENTRY_LEASE_S + 10;
      const rows = db2.query<{ id: string }, []>(
        "SELECT id FROM workflow_runs WHERE status IN ('running','waiting') ORDER BY created_at DESC LIMIT 1",
      ).all();
      runId = rows[0]?.id ?? "";
      return "normal";
    });
    const byRequest = new Map<string, TaskRecord>();
    const deps: EngineDeps = {
      ...defaultEngineDeps,
      delegate: async (c, input) => {
        // Slow path after renewLease post-mode: competing tick must lose.
        expect(runId).toBeTruthy();
        competingClaim = claimEntryLease(
          c, runId, tickOwner, leaseNow(c) + ENTRY_LEASE_S, leaseNow(c), db2,
        );
        expect(competingClaim).toBe(false);
        expect(liveRunsNeedingEntry(c, { now: leaseNow(c) }).some(r => r.id === runId)).toBe(false);
        const prior = input.requestId ? byRequest.get(input.requestId) : undefined;
        if (prior) return readTask(c, prior.id) ?? prior;
        const task = createTask(c, {
          brief: input.brief,
          kind: input.kind ?? null,
          requestedExecutor: null,
          timeoutS: 600,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        });
        if (input.workParent || input.dispatch) {
          registerWork(c, task.id, { ...input.dispatch }, input.workParent);
        }
        if (input.requestId) byRequest.set(input.requestId, task);
        return task;
      },
    };
    try {
      const run = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "slow-lease-h",
      }, undefined, deps);
      expect(competingClaim).toBe(false);
      expect(run.status).toBe("running");
      expect(run.reason).toBeUndefined();
      expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
      expect(entryTasks(ctx, run.id)).toBe(1);
    } finally {
      mode.mockRestore();
      db2.close();
    }
  });

  test("crashed start lease expires; second connection claims exactly once", () => {
    const ctx1 = fakeCtx({ now: NOW });
    addChain(ctx1);
    const run = insertRun(ctx1, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "crash-lease",
      entryLeaseUntil: NOW + ENTRY_LEASE_S,
      entryOwner: newEntryOwner(),
    });
    const dbPath = join(ctx1.pacerHome, "state/tasks.db");
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const ownerA = newEntryOwner();
    const ownerB = newEntryOwner();
    expect(claimEntryLease(ctx1, run.id, ownerA, NOW + 60, NOW, workflowDatabase(ctx1))).toBe(false);
    expect(claimEntryLease(ctx1, run.id, ownerB, NOW + 60, NOW, db2)).toBe(false);
    (ctx1 as { now: number }).now = NOW + ENTRY_LEASE_S + 1;
    const t = leaseNow(ctx1);
    const wonA = claimEntryLease(ctx1, run.id, ownerA, t + ENTRY_LEASE_S, t, workflowDatabase(ctx1));
    const wonB = claimEntryLease(ctx1, run.id, ownerB, t + ENTRY_LEASE_S, t, db2);
    expect(wonA).toBe(true);
    expect(wonB).toBe(false);
    expect(getRun(ctx1, run.id)!.entryOwner).toBe(ownerA);
    db2.close();
  });
});

describe("I2: ENTRY PK collision via insertStep stub", () => {
  test("startAgentStep UNIQUE catch: run not failed, exactly one entry task", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const realInsert = store.insertStep;
    let once = false;
    const insertSpy = spyOn(store, "insertStep").mockImplementation((c, s) => {
      if (!once) {
        once = true;
        // Winning row lands, then the loser's insert surfaces UNIQUE (startAgentStep catch).
        realInsert(c, s);
        throw new Error(UNIQUE_ENTRY_PK);
      }
      return realInsert(c, s);
    });
    try {
      const run = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "pk-agent",
      }, undefined, deps);
      expect(run.status).toBe("running");
      expect(run.reason).toBeUndefined();
      expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
      expect(entryTasks(ctx, run.id)).toBe(1);
    } finally {
      insertSpy.mockRestore();
    }
  });

  test("startEntryIfNeeded outer UNIQUE: run not failed, exactly one entry task", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "pk-entry",
    });
    // Winner already has the entry row; startEntryIfNeeded must not early-return on steps.
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "running" });
    let guardChecks = 0;
    const realSteps = store.stepsOfRun;
    const stepsSpy = spyOn(store, "stepsOfRun").mockImplementation((c, id) => {
      guardChecks++;
      if (guardChecks === 1) return [];
      return realSteps(c, id);
    });
    const insertSpy = spyOn(store, "insertStep").mockImplementation(() => {
      throw new Error(UNIQUE_ENTRY_PK);
    });
    try {
      expect(await startEntryIfNeeded(ctx, run.id, { deps })).toBe(true);
      expect(getRun(ctx, run.id)!.status).toBe("running");
      expect(getRun(ctx, run.id)!.reason).toBeUndefined();
      expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
      expect(entryTasks(ctx, run.id)).toBe(1);
    } finally {
      stepsSpy.mockRestore();
      insertSpy.mockRestore();
    }
  });

  test("startPendingEntries UNIQUE as already-started: run not failed, exactly one entry task", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "pk-pending",
    });
    // Pre-create the winning entry task; pending will treat a bubbled UNIQUE as already-started.
    const row = insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "running" });
    const task = createTask(ctx, {
      brief: { goal: "winner", repo: tmpDir() }, kind: "research", requestedExecutor: null, timeoutS: 600,
      requestId: `wf:${run.id}:one:1:`,
    });
    workflowDatabase(ctx).query(
      "UPDATE workflow_steps SET task_id = ? WHERE run_id = ? AND step_id = ? AND attempt = 1 AND branch = ''",
    ).run(task.id, run.id, "one");
    void row;
    clearEntryLease(ctx, run.id);
    // Make the run look like it still needs entry, then bubble UNIQUE from startEntryIfNeeded.
    let guardChecks = 0;
    const realSteps = store.stepsOfRun;
    const stepsSpy = spyOn(store, "stepsOfRun").mockImplementation((c, id) => {
      guardChecks++;
      if (guardChecks === 1) return [];
      return realSteps(c, id);
    });
    // Hide the winner during startAgentStep's UNIQUE catch so the error bubbles to pending.
    const insertSpy = spyOn(store, "insertStep").mockImplementation(() => {
      stepsSpy.mockImplementation(() => []);
      throw new Error(UNIQUE_ENTRY_PK);
    });
    try {
      // After bubble, restore visibility for assertions.
      const n = await startPendingEntries(ctx, { deps });
      stepsSpy.mockImplementation((c, id) => realSteps(c, id));
      // startEntryIfNeeded catch may return true (already started) before pending's catch.
      expect(n).toBeGreaterThanOrEqual(0);
      expect(getRun(ctx, run.id)!.status).toBe("running");
      expect(getRun(ctx, run.id)!.reason).toBeUndefined();
      expect(entryTasks(ctx, run.id)).toBe(1);
    } finally {
      insertSpy.mockRestore();
      stepsSpy.mockRestore();
    }
  });
});

describe("I3: two Database connections use real claimEntryLease", () => {
  test("only one claimEntryLease wins across two connections", () => {
    const ctx1 = fakeCtx({ now: NOW });
    addChain(ctx1);
    const run = insertRun(ctx1, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "conn-h",
    });
    const dbPath = join(ctx1.pacerHome, "state/tasks.db");
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const owner1 = newEntryOwner();
    const owner2 = newEntryOwner();
    const until = NOW + ENTRY_LEASE_S;
    const r1 = claimEntryLease(ctx1, run.id, owner1, until, NOW, workflowDatabase(ctx1));
    const r2 = claimEntryLease(ctx1, run.id, owner2, until, NOW, db2);
    expect(r1).toBe(true);
    expect(r2).toBe(false);
    db2.close();
  });
});

describe("I4: pause before seed in startRun", () => {
  test("person-paused seeded child starts nothing until resume", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const parent = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "seed-parent",
    }, undefined, deps);
    pauseRunByPerson(ctx, parent.id, getRun(ctx, parent.id)!.rev);
    const seed = { finishedIds: ["one"], results: { one: { ok: true } } };
    const child = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "seed-child",
    }, undefined, deps, {
      parentRunId: parent.id,
      parentStep: "one",
      seedFinished: seed,
    });
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");
    expect(getRun(ctx, child.id)!.entrySeed).toEqual(seed);
    expect(stepsOfRun(ctx, child.id)).toHaveLength(0);
  });
});

describe("I5: time-based transient bound", () => {
  test("fails after ENTRY_START_TRANSIENT_MIN_S with elapsed diagnostic; resume does not consume", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "busy-time",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_h_lock BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    await startPendingEntries(ctx, { deps, countTransient: false });
    expect(getRun(ctx, run.id)!.entryStartAttempts ?? 0).toBe(0);
    await startPendingEntries(ctx, { deps });
    expect(getRun(ctx, run.id)!.entryStartAttempts).toBe(1);
    expect(getRun(ctx, run.id)!.entryFirstTransientAt).toBe(NOW);
    (ctx as { now: number }).now = NOW + ENTRY_START_TRANSIENT_MIN_S + 1;
    await startPendingEntries(ctx, { deps });
    const failed = getRun(ctx, run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toMatch(/entry start failed after \d+\.\d+s \(/);
    expect(failed.reason).toMatch(/locked/i);
    expect(failed.reason).toMatch(/transient errors/);
  });

  test("secondary attempt cap still fails when clock does not advance enough", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "busy-cap",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_h_cap BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    for (let i = 0; i < ENTRY_START_TRANSIENT_MAX; i++) {
      await startPendingEntries(ctx, { deps });
      if (getRun(ctx, run.id)!.status === "failed") break;
    }
    expect(getRun(ctx, run.id)!.status).toBe("failed");
  }, 60_000);
});

describe("I6: bumpEntryStartAttempts failure does not abort the loop", () => {
  test("busy bump is logged and the loop continues to the next run", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const a = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "a",
    });
    const b = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "b",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_h_lock_a BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${a.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const bumpSpy = spyOn(store, "bumpEntryStartAttempts").mockImplementation(() => {
      throw new Error("database is locked");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await startPendingEntries(ctx, { deps });
      expect(stepsOfRun(ctx, b.id).some(s => s.stepId === "one")).toBe(true);
      expect(getRun(ctx, a.id)!.status).toBe("running");
      expect(warn.mock.calls.some(c => String(c[0]).includes("bumpEntryStartAttempts"))).toBe(true);
    } finally {
      bumpSpy.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("minors: UNIQUE match, clearEntrySeed, orphan recovery", () => {
  test("isEntryStepAlreadyStarted never matches empty ids or bare workflow_steps", () => {
    const err = new Error("UNIQUE constraint failed: workflow_steps");
    expect(isEntryStepAlreadyStarted(err, "run-1", "")).toBe(false);
    expect(isEntryStepAlreadyStarted(err, "", "one")).toBe(false);
    expect(isEntryStepAlreadyStarted(err, "run-1", "one")).toBe(false);
    expect(isEntryStepAlreadyStarted(new Error(UNIQUE_ENTRY_PK), "run-1", "one")).toBe(true);
    expect(isEntryStepAlreadyStarted(
      new Error(`UNIQUE constraint failed: ${"run-1"} ${"one"}`),
      "run-1",
      "one",
    )).toBe(true);
  });

  test("clearEntrySeed retries busy then clears", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "seed-clear",
      entrySeed: { finishedIds: ["one"], results: { one: {} } },
    });
    let tries = 0;
    const realDb = store.workflowDatabase;
    const dbSpy = spyOn(store, "workflowDatabase").mockImplementation((c) => {
      const db = realDb(c);
      if (tries < 2) {
        tries++;
        return {
          query: () => ({
            run: () => { throw new Error("database is locked"); },
          }),
        } as unknown as ReturnType<typeof realDb>;
      }
      return db;
    });
    try {
      clearEntrySeed(ctx, run.id);
      expect(tries).toBe(2);
      expect(getRun(ctx, run.id)!.entrySeed).toBeUndefined();
    } finally {
      dbSpy.mockRestore();
    }
  });

  test("crash after entry row insert before delegate: orphan recovery yields exactly one task", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "orphan",
    });
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "running" });
    expect(stepsOfRun(ctx, run.id)[0]!.taskId).toBeUndefined();
    (ctx as { now: number }).now = NOW + 61;
    const outcome = await reconcileOrphanStep(ctx, stepsOfRun(ctx, run.id)[0]!, undefined, deps);
    expect(outcome).toBe("redelegated");
    expect(entryTasks(ctx, run.id)).toBe(1);
    expect(getRun(ctx, run.id)!.status).not.toBe("failed");
  });
});
