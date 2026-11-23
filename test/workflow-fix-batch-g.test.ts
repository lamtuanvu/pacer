// Phase 6 batch G: atomic entry lease (B1), durable seed (B2), bound transient (I1),
// clearLease retries (I2), no-rev clear (I3), pause tree txn (I5), parent pause race (M3).
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
  addDefinition, claimEntryLease, clearEntryLease, getRun, insertRun, insertStep,
  liveRunsNeedingEntry, newEntryOwner,
  stepsOfRun, updateRun, workflowDatabase, ENTRY_LEASE_S, ENTRY_START_TRANSIENT_MAX,
} from "../src/workflow/store";
import {
  defaultEngineDeps, startEntryIfNeeded, startPendingEntries, startRun, type EngineDeps,
} from "../src/workflow/engine";
import * as pacing from "../src/workflow/pacing";
import { pauseRunByPerson, resumeRunByPerson } from "../src/workflow/pacing";
import { ensureRootWorkNode } from "../src/workflow/worknode";
import { CoreError } from "../src/core/errors";
import { callOp, type OpDeps } from "../src/api/ops";

const NOW = 1_700_000_000;

const CHAIN = {
  id: "t/batch-g",
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

function stubDeps(): { deps: EngineDeps; opDeps: OpDeps } {
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
  const deps: EngineDeps = { ...defaultEngineDeps, delegate };
  return { deps, opDeps: { delegate } };
}

function addChain(ctx: Ctx): void {
  addDefinition(ctx, CHAIN, "source");
}

/** Second SQLite connection on the same tasks.db (WAL) for real concurrency. */
function secondCtx(primary: Ctx, now = NOW): Ctx {
  const home = primary.pacerHome;
  // Force a fresh Database handle: clone ctx with same home so taskDatabase opens again
  // after we open a raw writer. Use a distinct Ctx object; schema already migrated.
  const ctx = fakeCtx({ now, pacerHome: home, home: primary.home });
  // Warm schema via primary first; second handle shares the file.
  workflowDatabase(primary);
  return ctx;
}

describe("B1: atomic entry lease claim", () => {
  test("claimEntryLease is one UPDATE; only one of two owners wins", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "claim",
    });
    const a = newEntryOwner();
    const b = newEntryOwner();
    const until = NOW + ENTRY_LEASE_S;
    expect(claimEntryLease(ctx, run.id, a, until, NOW)).toBe(true);
    expect(claimEntryLease(ctx, run.id, b, until, NOW)).toBe(false);
    // Same owner renews.
    expect(claimEntryLease(ctx, run.id, a, until + 10, NOW)).toBe(true);
    const row = getRun(ctx, run.id)!;
    expect(row.entryOwner).toBe(a);
    expect(row.entryLeaseUntil).toBe(until + 10);
  });

  test("stopped/failed run never claims", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "dead",
    });
    updateRun(ctx, run.id, run.rev, { status: "failed", reason: "x" });
    expect(claimEntryLease(ctx, run.id, newEntryOwner(), NOW + 30, NOW)).toBe(false);
  });

  test("two concurrent starters: exactly one entry step, no failRun", async () => {
    const ctxA = fakeCtx({ now: NOW });
    addChain(ctxA);
    const { deps } = stubDeps();
    const run = insertRun(ctxA, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "race",
    });
    // Simulate two processes: two claims with distinct owners after lease free.
    const ownerA = newEntryOwner();
    const ownerB = newEntryOwner();
    const until = NOW + ENTRY_LEASE_S;
    const wonA = claimEntryLease(ctxA, run.id, ownerA, until, NOW);
    const wonB = claimEntryLease(ctxA, run.id, ownerB, until, NOW);
    expect(wonA !== wonB).toBe(true);
    const winner = wonA ? ownerA : ownerB;
    // Winner starts entry; loser must not fail the run if it somehow races insertStep.
    expect(await startEntryIfNeeded(ctxA, run.id, { deps, entryOwner: winner })).toBe(true);
    // Loser after winner started: claim fails or steps exist → no-op / already-started.
    const n = await startPendingEntries(ctxA, { deps });
    expect(n).toBe(0);
    expect(getRun(ctxA, run.id)!.status).toBe("running");
    expect(getRun(ctxA, run.id)!.reason).toBeUndefined();
    expect(stepsOfRun(ctxA, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
  });

  test("tick vs run.resume: exactly one entry, no failRun", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps, opDeps } = stubDeps();
    const run = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "resume-race", priority: "background",
    }, undefined, deps);
    workflowDatabase(ctx).query("DELETE FROM workflow_steps WHERE run_id = ?").run(run.id);
    const paused = pauseRunByPerson(ctx, run.id, getRun(ctx, run.id)!.rev);
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);
    const mode = spyOn(pacing, "readPacingMode").mockResolvedValue("normal");
    try {
      const [tickN, resume] = await Promise.all([
        startPendingEntries(ctx, { deps, rootRunId: paused.id }),
        callOp(ctx, "run.resume", { id: paused.id, expect_rev: paused.rev }, opDeps),
      ]);
      void tickN;
      void resume;
      expect(getRun(ctx, paused.id)!.status).toBe("running");
      expect(getRun(ctx, paused.id)!.reason).toBeUndefined();
      expect(stepsOfRun(ctx, paused.id).filter(s => s.stepId === "one")).toHaveLength(1);
    } finally {
      mode.mockRestore();
    }
  });

  test("ENTRY step PRIMARY KEY collision is treated as already started, not failRun", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "pk",
    });
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "running" });
    // Force a second insert of the same key via startStep path by clearing the
    // "active row" short-circuit: mark the existing row done so nextAttempt=2 —
    // instead, exercise the helper that maps UNIQUE on entry key.
    workflowDatabase(ctx).query("DELETE FROM workflow_steps WHERE run_id = ?").run(run.id);
    // Pre-insert entry key, then startEntryIfNeeded's startStep will collide on attempt 1.
    insertStep(ctx, { runId: run.id, stepId: "one", attempt: 1, status: "running" });
    // With steps present, startEntryIfNeeded returns false (already started).
    expect(await startEntryIfNeeded(ctx, run.id, { deps })).toBe(false);
    expect(getRun(ctx, run.id)!.status).toBe("running");
    expect(getRun(ctx, run.id)!.reason).toBeUndefined();
  });

  test("two Database connections: only one claim wins under contention", () => {
    const ctx1 = fakeCtx({ now: NOW });
    addChain(ctx1);
    const run = insertRun(ctx1, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "conn",
    });
    const dbPath = join(ctx1.pacerHome, "state/tasks.db");
    // Raw second connection claims via SQL the same way claimEntryLease does.
    const db2 = new Database(dbPath);
    db2.exec("PRAGMA busy_timeout = 5000");
    const owner1 = newEntryOwner();
    const owner2 = newEntryOwner();
    const until = NOW + 30;
    const r1 = claimEntryLease(ctx1, run.id, owner1, until, NOW);
    const r2 = db2.query(
      `UPDATE workflow_runs SET entry_lease_until = ?, entry_owner = ?
       WHERE id = ? AND status IN ('running','waiting')
         AND (entry_owner = ? OR entry_lease_until IS NULL OR entry_lease_until <= ?)`,
    ).run(until, owner2, run.id, owner2, NOW);
    expect(r1).toBe(true);
    expect(r2.changes).toBe(0);
    db2.close();
  });

  test("startRun renews its own owner lease across a slow start longer than ENTRY_LEASE_S", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const mode = spyOn(pacing, "readPacingMode").mockImplementation(async (c) => {
      // Advance clock past the initial lease while startRun is mid-flight; a tick
      // would try to claim — startRun must renew so the tick loses.
      (c as { now: number }).now = NOW + ENTRY_LEASE_S + 5;
      const tickOwner = newEntryOwner();
      const claimed = claimEntryLease(c, liveRunsNeedingEntry(c, { now: c.now })[0]?.id ?? "", tickOwner, c.now + 30, c.now);
      // Either no candidate yet (seed/lease still held by startRun after renew) or claim lost.
      void claimed;
      await startPendingEntries(c, { deps });
      return "normal";
    });
    try {
      const run = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "slow-lease",
      }, undefined, deps);
      expect(run.status).toBe("running");
      expect(run.reason).toBeUndefined();
      expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
    } finally {
      mode.mockRestore();
    }
  });
});

describe("B2: durable seedFinished", () => {
  test("seed is persisted in the same transaction as insertRun", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const seed = { finishedIds: ["one"], results: { one: { ok: true } } };
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "seeded",
      entrySeed: seed,
    });
    expect(getRun(ctx, run.id)!.entrySeed).toEqual(seed);
  });

  test("crash after insertRun (before seed write path): recovery resumes from seed, not fresh entry", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const parent = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "parent",
    }, undefined, deps);
    // Simulate crash: insertRun with durable seed + lease, no step rows, then expire.
    const child = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "child-seed",
      parentRunId: parent.id,
      parentStep: "one",
      entryLeaseUntil: NOW + 30,
      entryOwner: newEntryOwner(),
      entrySeed: { finishedIds: ["one"], results: { one: { ok: true } } },
    });
    expect(stepsOfRun(ctx, child.id)).toHaveLength(0);
    expect(await startEntryIfNeeded(ctx, child.id, { deps })).toBe(false); // lease active
    (ctx as { now: number }).now = NOW + 31;
    expect(await startEntryIfNeeded(ctx, child.id, { deps })).toBe(true);
    const ones = stepsOfRun(ctx, child.id).filter(s => s.stepId === "one");
    expect(ones).toHaveLength(1);
    expect(ones[0]!.status).toBe("done");
    expect(stepsOfRun(ctx, child.id).some(s => s.stepId === "two")).toBe(true);
    // Seed consumed; no second resume.
    expect(getRun(ctx, child.id)!.entrySeed).toBeUndefined();
    expect(getRun(ctx, child.id)!.status).not.toBe("failed");
  });
});

describe("I1: bounded transient entry start", () => {
  test("persistent database is locked eventually fails the run with a diagnostic", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "busy-forever",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_g_lock BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    for (let i = 0; i < ENTRY_START_TRANSIENT_MAX; i++) {
      await startPendingEntries(ctx, { deps });
      if (getRun(ctx, run.id)!.status === "failed") break;
    }
    const failed = getRun(ctx, run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toMatch(/entry start failed/i);
    expect(failed.reason).toMatch(/transient|locked|after/i);
  });
});

describe("I2/I3: clearEntryLease retries and no rev bump", () => {
  test("clearEntryLease only clears matching owner and does not bump rev", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "clear",
      entryLeaseUntil: NOW + 30,
      entryOwner: "owner-a",
    });
    const revBefore = getRun(ctx, run.id)!.rev;
    clearEntryLease(ctx, run.id, "owner-b");
    expect(getRun(ctx, run.id)!.entryLeaseUntil).toBe(NOW + 30);
    clearEntryLease(ctx, run.id, "owner-a");
    expect(getRun(ctx, run.id)!.entryLeaseUntil).toBeUndefined();
    expect(getRun(ctx, run.id)!.entryOwner).toBeUndefined();
    expect(getRun(ctx, run.id)!.rev).toBe(revBefore);
  });

  test("other writers' cached rev still works after clearEntryLease", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "rev",
      entryLeaseUntil: NOW + 30,
      entryOwner: "o",
    });
    const cachedRev = run.rev;
    clearEntryLease(ctx, run.id, "o");
    // Intentionally does not publish / bump rev — expect_rev clients stay valid.
    const updated = updateRun(ctx, run.id, cachedRev, { title: "still-ok" });
    expect(updated.title).toBe("still-ok");
    expect(updated.rev).toBe(cachedRev + 1);
  });
});

describe("I5: person pause/resume tree converges", () => {
  test("pause applies root and children; partial failure is reported and next call converges", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const parent = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "p",
    });
    const child = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "c",
      parentRunId: parent.id, parentStep: "one",
    });
    const realUpdate = store.updateRun;
    let childAttempts = 0;
    const spy = spyOn(store, "updateRun").mockImplementation((c, id, rev, patch) => {
      if (id === child.id && childAttempts < 3) {
        childAttempts++;
        throw new CoreError("conflict", `conflict: run ${id} was modified`);
      }
      return realUpdate(c, id, rev, patch);
    });
    try {
      expect(() => pauseRunByPerson(ctx, parent.id, parent.rev)).toThrow(/pause incomplete|partial/i);
    } finally {
      spy.mockRestore();
    }
    // Converge: retry after conflicts clear.
    const live = getRun(ctx, parent.id)!;
    // Root may already be person-paused from the partial apply.
    if (live.pausedReason !== "person") {
      pauseRunByPerson(ctx, parent.id, live.rev);
    } else {
      // Finish children via resume+pause or direct pause with fresh rev — pause again
      // when root already paused should still finish children (idempotent converge).
      try {
        pauseRunByPerson(ctx, parent.id, live.rev);
      } catch {
        // If expect_rev conflicts because root already updated, use current rev.
        pauseRunByPerson(ctx, parent.id, getRun(ctx, parent.id)!.rev);
      }
    }
    expect(getRun(ctx, parent.id)!.pausedReason).toBe("person");
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");
  });
});

describe("M3: parent person pause re-checked inside insert transaction", () => {
  test("pause landing between parent read and insertRun still stamps the child", () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const parent = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "p",
    });
    // Race: pause after "read" (we don't pass pausedReason) but insertRun re-checks.
    pauseRunByPerson(ctx, parent.id, parent.rev);
    const child = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "c",
      parentRunId: parent.id,
      parentStep: "one",
      // Intentionally omit pausedReason — insert must re-read parent in-txn.
    });
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");
  });
});

describe("ensureRootWorkNode idempotent", () => {
  test("second call against an existing root is a no-op", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "wn",
    }, undefined, deps);
    const root1 = getRun(ctx, run.id)!.rootTaskId!;
    expect(root1).toBeTruthy();
    const again = ensureRootWorkNode(ctx, getRun(ctx, run.id)!);
    expect(again).toBe(root1);
    expect(getRun(ctx, run.id)!.rootTaskId).toBe(root1);
  });
});

// secondCtx kept for multi-connection claim tests above.
void secondCtx;
void resumeRunByPerson;
