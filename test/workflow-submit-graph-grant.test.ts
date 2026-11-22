import { expect, test } from "bun:test";
import { fakeCtx, tmpDir } from "./helpers";
import { callOp } from "../src/api/ops";
import { addDefinition, insertRun, insertStep } from "../src/workflow/store";
import { insertTurn } from "../src/workflow/wakeups";
import { issueRunGrant, authorizeRunGrantOperation, RUN_GRANT_OPS } from "../src/workflow/run-grant";
import type { WorkflowDef } from "../src/workflow/schema";

const NOW = 1_700_000_000;

const parent: WorkflowDef = {
  id: "t/sg-grant",
  version: 1,
  steps: {
    plan: {
      type: "generate",
      prompt: "P",
      limits: { step_types: ["agent", "human", "fanout"], max_steps: 4 },
    },
    done: { type: "end" },
  },
  edges: [{ from: "plan", to: "done" }],
  entry: "plan",
};

test("RUN_GRANT_OPS includes run.submit_graph", () => {
  expect(RUN_GRANT_OPS as readonly string[]).toContain("run.submit_graph");
});

test("run.submit_graph grant for another run is refused (API-5b)", async () => {
  const ctx = fakeCtx({ now: NOW });
  addDefinition(ctx, parent, "source");
  const mine = insertRun(ctx, { workflow: parent.id, version: 1, repo: tmpDir(), brief: "mine" });
  const other = insertRun(ctx, { workflow: parent.id, version: 1, repo: tmpDir(), brief: "other" });
  insertStep(ctx, { runId: other.id, stepId: "plan", attempt: 1, status: "waiting" });
  insertTurn(ctx, {
    id: "turn_sg", runId: mine.id, planner: "claude-code", status: "running",
    startedAt: NOW, deadline: NOW + 1200,
  });
  const bearer = issueRunGrant(ctx, { runId: mine.id, turnId: "turn_sg", deadline: NOW + 600 });
  const granted = { ...ctx, env: { ...ctx.env, PACER_RUN_GRANT: bearer, PACER_ROLE: "orchestrator" } };

  expect(() => authorizeRunGrantOperation(granted, "run.submit_graph", {
    id: other.id, step: "plan", source: { id: "x", version: 1, steps: { done: { type: "end" } }, edges: [], entry: "done" },
  })).toThrow(/outside this run grant/i);

  await expect(callOp(granted, "run.submit_graph", {
    id: other.id,
    step: "plan",
    source: { id: "x", version: 1, steps: { done: { type: "end" } }, edges: [], entry: "done" },
  })).rejects.toMatchObject({ code: "not_allowed" });
});
