import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import { taskDatabase } from "../src/tasks/store";
import {
  addDefinition, claimStepAnswer, getRun, insertRun, insertStep, listDecisions,
  parseRunConflicts, resetWorkflowSchemaReadyForTests, setRunBranch, workflowDatabase,
} from "../src/workflow/store";
import { answerHumanStep } from "../src/workflow/engine";
import type { WorkflowDef } from "../src/workflow/schema";

test("R3-I3/F3: store migration turns legacy OBJECT conflict into a list (idempotent)", () => {
  const ctx = fakeCtx();
  // Open tasks.db WITHOUT running workflow schema init.
  const raw = taskDatabase(ctx);
  raw.exec(`
    CREATE TABLE workflow_runs(
      id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT,
      title TEXT, status TEXT, reason TEXT, loops TEXT, rev INTEGER,
      created_at REAL, updated_at REAL, conflict TEXT
    );
  `);
  const legacy = JSON.stringify({
    taskId: "t_old", branch: "pacer/t_old", resolutionTaskId: "t_res",
  });
  raw.query(
    `INSERT INTO workflow_runs(id, workflow, version, repo, brief, status, rev, created_at, updated_at, conflict)
     VALUES ('run_legacyobj1', 't/mig', 1, ?, 'b', 'running', 1, 1, 1, ?)`,
  ).run(tmpDir(), legacy);

  // First workflowDatabase call runs the store's object→list migration.
  workflowDatabase(ctx);
  const mid = raw.query<{ conflict: string | null }, [string]>(
    "SELECT conflict FROM workflow_runs WHERE id = ?",
  ).get("run_legacyobj1")!;
  expect(Array.isArray(JSON.parse(mid.conflict!))).toBe(true);
  expect(parseRunConflicts(mid.conflict)).toEqual([{
    taskId: "t_old", branch: "pacer/t_old", resolutionTaskId: "t_res",
  }]);

  // Second open re-runs migration (schema-ready reset) and is a no-op on a list.
  resetWorkflowSchemaReadyForTests();
  workflowDatabase(ctx);
  const again = raw.query<{ conflict: string | null }, [string]>(
    "SELECT conflict FROM workflow_runs WHERE id = ?",
  ).get("run_legacyobj1")!;
  expect(again.conflict).toBe(mid.conflict);

  // NULL stays NULL through migration.
  raw.query("UPDATE workflow_runs SET conflict = NULL WHERE id = ?").run("run_legacyobj1");
  resetWorkflowSchemaReadyForTests();
  workflowDatabase(ctx);
  expect(
    raw.query<{ conflict: string | null }, [string]>(
      "SELECT conflict FROM workflow_runs WHERE id = ?",
    ).get("run_legacyobj1")!.conflict,
  ).toBeNull();

  // Already-list seeded before init stays a list.
  const listJson = JSON.stringify([{ taskId: "t_a", branch: "pacer/t_a", resolutionTaskId: "t_r" }]);
  raw.query("UPDATE workflow_runs SET conflict = ? WHERE id = ?").run(listJson, "run_legacyobj1");
  resetWorkflowSchemaReadyForTests();
  workflowDatabase(ctx);
  expect(
    raw.query<{ conflict: string | null }, [string]>(
      "SELECT conflict FROM workflow_runs WHERE id = ?",
    ).get("run_legacyobj1")!.conflict,
  ).toBe(listJson);

  // Malformed fails closed (publish gate sees unresolved).
  expect(parseRunConflicts("{not-json")![0]!.taskId).toBe("__malformed__");
});

test("R3-I3: publish approval fails closed when tip cannot be read; step stays waiting; no decision", async () => {
  const ctx = fakeCtx({ run: realRun });
  workflowDatabase(ctx);
  const repo = gitRepo();
  const def: WorkflowDef = {
    id: "t/pub-tip",
    version: 1,
    entry: "approve",
    steps: {
      approve: {
        type: "human",
        decision: "must",
        approves: "publish",
        question: { kind: "approve_revise", text: "Publish?" },
      },
      done: { type: "end" },
    },
    edges: [{ from: "approve", to: "done" }],
  };
  addDefinition(ctx, def, "test");
  const run = insertRun(ctx, {
    workflow: "t/pub-tip", version: 1, repo, brief: "b", stepMode: "plain",
  });
  // Branch name that does not exist → rev-parse fails.
  setRunBranch(ctx, run.id, { branch: "pacer/missing-branch", base_ref: "main", base_sha: "b".repeat(40) });
  insertStep(ctx, { runId: run.id, stepId: "approve", attempt: 1, status: "waiting" });
  const live = getRun(ctx, run.id)!;

  await expect(answerHumanStep(ctx, live.id, "approve", "approve", live.rev))
    .rejects.toThrow(/cannot read branch tip|unavailable/i);

  const steps = workflowDatabase(ctx).query<{ status: string }, [string]>(
    "SELECT status FROM workflow_steps WHERE run_id = ? AND step_id = 'approve'",
  ).all(live.id);
  expect(steps.every(s => s.status === "waiting")).toBe(true);
  expect(listDecisions(ctx, live.id).filter(d => d.kind === "publish_approved")).toEqual([]);
});

test("R3-I3: decision rolls back with the claim when the decision insert fails", () => {
  const ctx = fakeCtx();
  const db = workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/claim", version: 1, repo: tmpDir(), brief: "b" });
  insertStep(ctx, { runId: run.id, stepId: "ask", attempt: 1, status: "waiting" });

  // Inject failure: replace decisions table with one that rejects every INSERT.
  db.exec("DROP TABLE workflow_decisions");
  db.exec(`
    CREATE TABLE workflow_decisions(
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      actor TEXT NOT NULL,
      kind TEXT NOT NULL,
      choice TEXT NOT NULL,
      reason TEXT NOT NULL,
      at REAL NOT NULL,
      CHECK (0)
    )
  `);

  let threw = false;
  try {
    claimStepAnswer(ctx, { runId: run.id, stepId: "ask", attempt: 1, branch: "" }, { answer: "yes" }, {
      decision: {
        runId: run.id, stepId: "ask", attempt: 1, actor: "person",
        kind: "publish_approved", choice: "approve", reason: "tip=deadbeef",
      },
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  const row = db.query<{ status: string }, [string]>(
    "SELECT status FROM workflow_steps WHERE run_id = ? AND step_id = 'ask'",
  ).get(run.id)!;
  // Claim rolled back with the failed decision insert.
  expect(row.status).toBe("waiting");
});
