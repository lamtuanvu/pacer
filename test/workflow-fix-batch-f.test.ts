// Phase 6 batch F: I1 transient entry-start, I2 startRun/tick ownership, minors.
import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import type { Ctx } from "../src/types";
import { createTask, readTask, taskDatabase } from "../src/tasks/store";
import type { TaskRecord } from "../src/tasks/types";
import type { DelegateInput } from "../src/tasks/api";
import { registerWork } from "../src/dispatch/work";
import * as store from "../src/workflow/store";
import {
  addDefinition, getRun, insertRun, resetWorkflowSchemaReadyForTests, stepsOfRun,
  workflowDatabase,
} from "../src/workflow/store";
import {
  defaultEngineDeps, startEntryIfNeeded, startPendingEntries, startRun, type EngineDeps,
} from "../src/workflow/engine";
import * as pacing from "../src/workflow/pacing";
import { pauseRunByPerson } from "../src/workflow/pacing";
import { callOp, type OpDeps } from "../src/api/ops";
import { CoreError } from "../src/core/errors";
import { mkdirSync } from "node:fs";

const NOW = 1_700_000_000;

const CHAIN = {
  id: "t/batch-f",
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

describe("I1: transient entry start must not fail the run", () => {
  test("SQLITE_BUSY on first entry start leaves the run live; next tick starts it", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    // Paused-at-start shape: live, unpaused, no steps.
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "locked",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_i1_lock BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'database is locked'); END`,
    );
    const n = await startPendingEntries(ctx, { deps });
    expect(n).toBe(0);
    expect(getRun(ctx, run.id)!.status).toBe("running");
    expect(getRun(ctx, run.id)!.reason).toBeUndefined();
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);

    workflowDatabase(ctx).exec("DROP TRIGGER wf_i1_lock");
    const n2 = await startPendingEntries(ctx, { deps });
    expect(n2).toBe(1);
    expect(stepsOfRun(ctx, run.id).some(s => s.stepId === "one")).toBe(true);
    expect(getRun(ctx, run.id)!.status).toBe("running");
  });

  test("non-transient entry start failure still fails the run with a diagnostic", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "boom",
    });
    workflowDatabase(ctx).exec(
      `CREATE TRIGGER wf_i1_boom BEFORE INSERT ON workflow_steps WHEN NEW.run_id = '${run.id}' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );
    await startPendingEntries(ctx, { deps });
    const failed = getRun(ctx, run.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.reason).toContain("entry start failed:");
    expect(failed.reason).toContain("disk I/O error");
  });
});

describe("I2: startRun owns entry start until lease expires", () => {
  test("tick between insertRun and entry start does not double-start a plain run", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const mode = spyOn(pacing, "readPacingMode").mockImplementation(async (c) => {
      await startPendingEntries(c, { deps });
      return "normal";
    });
    try {
      const run = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "race-plain",
      }, undefined, deps);
      expect(run.status).toBe("running");
      expect(run.reason).toBeUndefined();
      expect(stepsOfRun(ctx, run.id).filter(s => s.stepId === "one")).toHaveLength(1);
    } finally {
      mode.mockRestore();
    }
  });

  test("tick during seedFinished child start does not orphan a task or fail the run", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const parent = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "parent",
    }, undefined, deps);
    const mode = spyOn(pacing, "readPacingMode").mockImplementation(async (c) => {
      await startPendingEntries(c, { deps });
      return "normal";
    });
    try {
      const child = await startRun(ctx, {
        workflow: CHAIN.id, repo: tmpDir(), brief: "child-seed",
      }, undefined, deps, {
        parentRunId: parent.id,
        parentStep: "one",
        seedFinished: { finishedIds: ["one"], results: { one: { ok: true } } },
      });
      expect(child.status).not.toBe("failed");
      expect(child.reason).toBeUndefined();
      const ones = stepsOfRun(ctx, child.id).filter(s => s.stepId === "one");
      expect(ones).toHaveLength(1);
      expect(ones[0]!.status).toBe("done");
      // Frontier resumed at two — not a duplicate fresh entry.
      expect(stepsOfRun(ctx, child.id).some(s => s.stepId === "two")).toBe(true);
    } finally {
      mode.mockRestore();
    }
  });

  test("expired entry lease lets the tick recover a crashed startRun", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "crashed",
      entryLeaseUntil: NOW + 30,
    });
    expect(await startEntryIfNeeded(ctx, run.id, { deps })).toBe(false);
    expect(stepsOfRun(ctx, run.id)).toHaveLength(0);

    (ctx as { now: number }).now = NOW + 31;
    expect(await startEntryIfNeeded(ctx, run.id, { deps })).toBe(true);
    expect(stepsOfRun(ctx, run.id).some(s => s.stepId === "one")).toBe(true);
  });
});

describe("batch F minors", () => {
  test("schema backfill skips letters held by terminal rows via real workflowDatabase init", () => {
    const ctx = fakeCtx({ now: NOW });
    // Build a pre-letter schema by hand, then let workflowDatabase migrate it.
    const dbPath = join(ctx.pacerHome, "state/tasks.db");
    mkdirSync(join(ctx.pacerHome, "state"), { recursive: true });
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE workflow_runs(
        id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
        status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL
      );
      INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
      VALUES ('run_term', 't/letter', 1, '/r', 'done', 'done', 'done', NULL, '{}', 1, 1, 1);
      INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
      VALUES ('run_live', 't/letter', 1, '/r', 'live', 'live', 'running', NULL, '{}', 1, 2, 2);
    `);
    // Terminal already holds A as if assigned before the live row existed letterlessly.
    raw.exec("ALTER TABLE workflow_runs ADD COLUMN letter TEXT");
    raw.exec("UPDATE workflow_runs SET letter = 'A' WHERE id = 'run_term'");
    raw.close();

    resetWorkflowSchemaReadyForTests();
    // Force task store + workflow schema init (letter backfill for live letterless).
    taskDatabase(ctx);
    workflowDatabase(ctx);
    const live = workflowDatabase(ctx).query<{ letter: string | null }, [string]>(
      "SELECT letter FROM workflow_runs WHERE id = ?",
    ).get("run_live");
    const term = workflowDatabase(ctx).query<{ letter: string | null }, [string]>(
      "SELECT letter FROM workflow_runs WHERE id = ?",
    ).get("run_term");
    expect(term?.letter).toBe("A");
    expect(live?.letter).toBe("B");
  });

  test("child started after person pause inherits the parent person pause", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    const parent = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "p",
    }, undefined, deps);
    pauseRunByPerson(ctx, parent.id, getRun(ctx, parent.id)!.rev);
    const child = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "c",
    }, undefined, deps, {
      parentRunId: parent.id,
      parentStep: "one",
    });
    expect(getRun(ctx, child.id)!.pausedReason).toBe("person");
    expect(stepsOfRun(ctx, child.id)).toHaveLength(0);
  });

  test("person pause/resume reports child rev conflicts instead of swallowing them", () => {
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
      if (id === child.id) {
        childAttempts++;
        throw new CoreError("conflict", `conflict: run ${id} was modified`);
      }
      return realUpdate(c, id, rev, patch);
    });
    try {
      expect(() => pauseRunByPerson(ctx, parent.id, parent.rev)).toThrow(/pause incomplete/);
      expect(childAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      spy.mockRestore();
    }
  });

  test("startEntryIfNeeded ensures root work node for work_node recovery", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps } = stubDeps();
    // Crash between insertRun and ensureRootWorkNode: work_node run, no root_task_id, no steps.
    const run = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "wn",
      stepMode: "work_node",
    });
    expect(getRun(ctx, run.id)!.rootTaskId).toBeUndefined();
    await startEntryIfNeeded(ctx, run.id, { deps });
    expect(getRun(ctx, run.id)!.rootTaskId).toBeTruthy();
    expect(stepsOfRun(ctx, run.id).some(s => s.stepId === "one")).toBe(true);
  });

  test("run.resume scopes pending entry starts to the resumed run tree", async () => {
    const ctx = fakeCtx({ now: NOW });
    addChain(ctx);
    const { deps, opDeps } = stubDeps();
    const other = insertRun(ctx, {
      workflow: CHAIN.id, version: 1, repo: tmpDir(), brief: "other",
    });
    const target = await startRun(ctx, {
      workflow: CHAIN.id, repo: tmpDir(), brief: "target", priority: "background",
    }, undefined, {
      ...deps,
      // Force pause-at-start by syncing after a mocked emergency mode.
    });
    // Make target paused-at-start with no steps.
    workflowDatabase(ctx).query("DELETE FROM workflow_steps WHERE run_id = ?").run(target.id);
    const paused = pauseRunByPerson(ctx, target.id, getRun(ctx, target.id)!.rev);
    expect(stepsOfRun(ctx, target.id)).toHaveLength(0);
    expect(stepsOfRun(ctx, other.id)).toHaveLength(0);

    const mode = spyOn(pacing, "readPacingMode").mockResolvedValue("normal");
    try {
      await callOp(ctx, "run.resume", { id: target.id, expect_rev: paused.rev }, opDeps);
      expect(stepsOfRun(ctx, target.id).some(s => s.stepId === "one")).toBe(true);
      // Unrelated pending live run must not be started by this resume.
      expect(stepsOfRun(ctx, other.id)).toHaveLength(0);
    } finally {
      mode.mockRestore();
    }
  });
});
