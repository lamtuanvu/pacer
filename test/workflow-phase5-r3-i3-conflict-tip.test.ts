import { expect, test } from "bun:test";
import { fakeCtx, gitRepo, realRun, tmpDir } from "./helpers";
import {
  addDefinition, claimStepAnswer, getRun, insertRun, insertStep, listDecisions,
  parseRunConflicts, setRunBranch, workflowDatabase,
} from "../src/workflow/store";
import { answerHumanStep } from "../src/workflow/engine";
import type { WorkflowDef } from "../src/workflow/schema";

test("R3-I3: legacy OBJECT conflict migrates to list; idempotent; NULL and list stay safe", () => {
  const ctx = fakeCtx();
  const db = workflowDatabase(ctx);
  const run = insertRun(ctx, { workflow: "t/mig", version: 1, repo: tmpDir(), brief: "b" });

  // Seed a pre-R2-F3 object-shaped marker directly (bypass setRunConflict).
  const legacy = JSON.stringify({
    taskId: "t_old", branch: "pacer/t_old", resolutionTaskId: "t_res",
  });
  db.query("UPDATE workflow_runs SET conflict = ? WHERE id = ?").run(legacy, run.id);

  // Schema init is cached; exercise the same idempotent migration SQL the store runs.
  const migrateSql = `
    UPDATE workflow_runs
    SET conflict = json_array(json(conflict))
    WHERE conflict IS NOT NULL
      AND json_valid(conflict)
      AND json_type(conflict) = 'object'
  `;
  db.exec(migrateSql);
  const mid = db.query<{ conflict: string | null }, [string]>(
    "SELECT conflict FROM workflow_runs WHERE id = ?",
  ).get(run.id)!;
  expect(Array.isArray(JSON.parse(mid.conflict!))).toBe(true);
  expect(parseRunConflicts(mid.conflict)).toEqual([{
    taskId: "t_old", branch: "pacer/t_old", resolutionTaskId: "t_res",
  }]);

  // Already-list: migration is a no-op (json_type is array, not object).
  db.exec(migrateSql);
  const again = db.query<{ conflict: string | null }, [string]>(
    "SELECT conflict FROM workflow_runs WHERE id = ?",
  ).get(run.id)!;
  expect(again.conflict).toBe(mid.conflict);

  // NULL stays NULL.
  db.query("UPDATE workflow_runs SET conflict = NULL WHERE id = ?").run(run.id);
  expect(getRun(ctx, run.id)!.conflict).toBeUndefined();

  // parseRunConflicts still accepts a legacy object without migration.
  expect(parseRunConflicts(legacy)).toEqual([{
    taskId: "t_old", branch: "pacer/t_old", resolutionTaskId: "t_res",
  }]);

  // Malformed fails closed (publish gate sees unresolved).
  db.query("UPDATE workflow_runs SET conflict = ? WHERE id = ?").run("{not-json", run.id);
  expect(parseRunConflicts("{not-json")![0]!.taskId).toBe("__malformed__");
  expect((getRun(ctx, run.id)!.conflict?.length ?? 0) > 0).toBe(true);
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
